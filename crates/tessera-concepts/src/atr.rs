use std::collections::BTreeMap;

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::{
    AvailableAt, Concept, ConceptError, ConceptInfo, ConceptInput, ConceptSeries, Lookback,
    OutputKind, OutputSpec, parse_params,
};

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", default, deny_unknown_fields)]
pub struct AtrParams {
    /// Smoothing period (default 14).
    pub period: usize,
}

impl Default for AtrParams {
    fn default() -> Self {
        Self { period: 14 }
    }
}

#[derive(Clone, Copy, Debug, Default)]
pub struct Atr;

impl Concept for Atr {
    fn info(&self) -> ConceptInfo {
        ConceptInfo {
            id: "atr".into(),
            version: 1,
            title: "ATR (Wilder)".into(),
            description: "Average true range with Wilder smoothing; first value is the mean of the first `period` true ranges.".into(),
            params_schema: serde_json::to_value(schemars::schema_for!(AtrParams)).unwrap_or(Value::Null),
            outputs: vec![
                OutputSpec {
                    name: "atr".into(),
                    kind: OutputKind::Value,
                    description: "Average true range in price units.".into(),
                },
                OutputSpec {
                    name: "tr".into(),
                    kind: OutputKind::Value,
                    description: "True range of the bar.".into(),
                },
            ],
            lookback: Lookback::Unbounded,
            available_at: AvailableAt::BarClose,
        }
    }

    fn compute(
        &self,
        input: &ConceptInput<'_>,
        params: &Value,
    ) -> Result<ConceptSeries, ConceptError> {
        let p: AtrParams = parse_params(params)?;
        if p.period == 0 {
            return Err(ConceptError::InvalidParams(
                "period must be at least 1".into(),
            ));
        }
        let n = input.bars.len();
        let mut tr = Vec::with_capacity(n);
        let mut atr = Vec::with_capacity(n);
        let mut prev_close: Option<f64> = None;
        let mut sum = 0.0;
        let mut current: Option<f64> = None;
        let period = p.period as f64;
        for (i, b) in input.bars.iter().enumerate() {
            let (h, l, c) = (b.h.to_f64(), b.l.to_f64(), b.c.to_f64());
            let r = match prev_close {
                Some(pc) => (h - l).max((h - pc).abs()).max((l - pc).abs()),
                None => h - l,
            };
            prev_close = Some(c);
            tr.push(Some(r));
            current = match current {
                Some(a) => Some((a * (period - 1.0) + r) / period),
                None => {
                    sum += r;
                    (i + 1 == p.period).then(|| sum / period)
                }
            };
            atr.push(current);
        }
        let first = atr.iter().position(Option::is_some);
        let mut columns = BTreeMap::new();
        columns.insert("atr".into(), atr);
        columns.insert("tr".into(), tr);
        Ok(ConceptSeries {
            implementation_id: self.info().implementation_id(),
            t: input.bars.iter().map(|b| b.t).collect(),
            columns,
            warmup_complete_at: first,
            quality_flags: Vec::new(),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::check_no_lookahead;
    use crate::testutil::{approx, bar};
    use tessera_core::session::SessionCalendar;
    use tessera_core::{InstrumentId, Timeframe};

    #[test]
    fn wilder_values() {
        let id = InstrumentId::new("NQZ6.CME").unwrap();
        let bars = [
            bar("2026-10-02T13:30:00Z", 9.0, 10.0, 8.0, 9.0, 1.0),
            bar("2026-10-02T13:31:00Z", 9.0, 11.0, 9.0, 10.0, 1.0),
            bar("2026-10-02T13:32:00Z", 10.0, 12.0, 9.0, 11.0, 1.0),
            bar("2026-10-02T13:33:00Z", 11.0, 11.0, 10.0, 10.5, 1.0),
            bar("2026-10-02T13:34:00Z", 10.5, 13.0, 11.0, 12.0, 1.0),
        ];
        let input = ConceptInput {
            instrument: &id,
            tf: Timeframe::M1,
            bars: &bars,
            calendar: SessionCalendar::CmeEquityIndex,
        };
        let params = serde_json::json!({"period": 3});
        let s = Atr.compute(&input, &params).unwrap();
        let a = s.column("atr").unwrap();
        assert_eq!(a[0], None);
        assert_eq!(a[1], None);
        assert!(approx(a[2], 7.0 / 3.0));
        assert!(approx(a[3], (7.0 / 3.0 * 2.0 + 1.0) / 3.0));
        assert!(approx(
            a[4],
            ((7.0 / 3.0 * 2.0 + 1.0) / 3.0 * 2.0 + 2.5) / 3.0
        ));
        let t = s.column("tr").unwrap();
        assert!(approx(t[4], 2.5));
        assert_eq!(s.warmup_complete_at, Some(2));
        check_no_lookahead(&Atr, &input, &params).unwrap();
        assert!(
            Atr.compute(&input, &serde_json::json!({"period": 0}))
                .is_err()
        );
        let default = Atr.compute(&input, &Value::Null).unwrap();
        assert!(
            default.column("atr").unwrap().iter().all(Option::is_none),
            "period 14 > 5 bars"
        );
    }
}
