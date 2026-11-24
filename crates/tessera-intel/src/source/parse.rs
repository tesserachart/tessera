use std::str::FromStr;

use rust_decimal::prelude::FromPrimitive;
use rust_decimal::{Decimal, RoundingStrategy};
use serde_json::Value;
use tessera_core::conversion::ConversionRecord;
use tessera_core::instrument::ContractSpec;
use tessera_core::levels::{ConceptAnnotation, Level, VendorRef};
use tessera_core::{InstrumentId, Price, Timestamp};

use super::select::{Selector, select, text_of};
use super::spec::{RequestSpec, TimeField, TimeUnit, ValueUnit};
use tessera_core::ids::slug;

pub const DEFAULT_GROUP: &str = "levels";

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ParsedValue {
    pub package: String,
    pub endpoint: String,
    pub field: String,
    pub label: String,
    pub short: Option<String>,
    pub group: String,
    pub value: Result<Decimal, String>,
    pub concept: Option<ConceptAnnotation>,
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Parsed {
    pub as_of: Option<Timestamp>,
    pub spot: Option<Decimal>,
    pub values: Vec<ParsedValue>,
    pub problems: Vec<String>,
}

pub fn number(v: &Value) -> Option<Decimal> {
    match v {
        Value::Number(n) => {
            let s = n.to_string();
            Decimal::from_str(&s)
                .or_else(|_| Decimal::from_scientific(&s))
                .ok()
                .or_else(|| n.as_f64().and_then(Decimal::from_f64))
        }
        Value::String(s) => {
            let s = s.trim();
            Decimal::from_str(s)
                .or_else(|_| Decimal::from_scientific(s))
                .ok()
        }
        _ => None,
    }
}

fn decimal(x: f64) -> Decimal {
    Decimal::from_f64(x).unwrap_or_default()
}

pub fn time(field: &TimeField, body: &Value) -> Option<Timestamp> {
    let v = select(&field.path, body)?;
    match field.unit {
        TimeUnit::Rfc3339 => Timestamp::parse(v.as_str()?).ok(),
        unit => {
            let n = number(v)?;
            let (scale, _) = match unit {
                TimeUnit::Seconds => (Decimal::from(1_000_000_000i64), ()),
                TimeUnit::Millis => (Decimal::from(1_000_000i64), ()),
                TimeUnit::Nanos | TimeUnit::Rfc3339 => (Decimal::ONE, ()),
            };
            i64::try_from((n * scale).trunc()).ok().map(Timestamp)
        }
    }
}

struct Transform<'a> {
    unit: ValueUnit,
    scale: Option<f64>,
    offset: Option<f64>,
    na_if: &'a [f64],
    na_reason: Option<&'a str>,
}

impl Transform<'_> {
    fn apply(&self, raw: Option<&Value>, spot: Option<Decimal>) -> Result<Decimal, String> {
        let raw = match raw {
            None => return Err("missing from the response".into()),
            Some(Value::Null) => return Err("the vendor sent no value".into()),
            Some(v) => number(v).ok_or_else(|| format!("not a number: {}", text_of(v)))?,
        };
        if self
            .na_if
            .iter()
            .any(|na| (decimal(*na) - raw).abs() < Decimal::new(1, 9))
        {
            return Err(self
                .na_reason
                .unwrap_or("the vendor marks it not applicable")
                .to_owned());
        }
        let mut v = raw;
        if let Some(s) = self.scale {
            v *= decimal(s);
        }
        if let Some(o) = self.offset {
            v += decimal(o);
        }
        if self.unit == ValueUnit::Offset {
            v += spot.ok_or("no spot in the response to count the offset from")?;
        }
        Ok(v)
    }
}

pub fn parse(req: &RequestSpec, body: &Value) -> Parsed {
    let mut out = Parsed::default();
    if let Some(t) = &req.as_of {
        out.as_of = time(t, body);
        if out.as_of.is_none() {
            out.problems
                .push(format!("{}: no snapshot time at {}", req.id, t.path));
        }
    }
    if let Some(s) = &req.spot {
        out.spot = select(s, body).and_then(number);
    }
    let group = req.group.clone().unwrap_or_else(|| DEFAULT_GROUP.into());
    let endpoint = req.endpoint();
    for f in &req.fields {
        let raw = Selector::parse(&f.value_path())
            .ok()
            .and_then(|s| s.select(body).cloned());
        let value = Transform {
            unit: f.unit,
            scale: f.scale,
            offset: f.offset,
            na_if: &f.na_if,
            na_reason: f.na_reason.as_deref(),
        }
        .apply(raw.as_ref(), out.spot);
        if let Err(why) = &value
            && raw.is_none()
        {
            let shown = f.path.as_deref().unwrap_or(&f.field);
            out.problems
                .push(format!("{}.{}: {why} ({shown})", req.id, f.field));
        }
        out.values.push(ParsedValue {
            package: req.package.clone(),
            endpoint: endpoint.clone(),
            field: f.field.clone(),
            label: f.label.clone().unwrap_or_else(|| f.field.clone()),
            short: f.short.clone(),
            group: f.group.clone().unwrap_or_else(|| group.clone()),
            value,
            concept: f.concept.clone(),
        });
    }
    if let Some(it) = &req.items {
        match select(&it.path, body).and_then(Value::as_array) {
            None => out
                .problems
                .push(format!("{}: no list at {}", req.id, it.path)),
            Some(items) => {
                let t = Transform {
                    unit: it.unit,
                    scale: it.scale,
                    offset: it.offset,
                    na_if: &it.na_if,
                    na_reason: None,
                };
                for item in items {
                    let Some(field) = select(&it.field, item)
                        .map(text_of)
                        .filter(|f| !f.trim().is_empty())
                    else {
                        out.problems
                            .push(format!("{}: an item with no {}", req.id, it.field));
                        continue;
                    };
                    if out
                        .values
                        .iter()
                        .any(|v| v.field == field && v.package == req.package)
                    {
                        continue;
                    }
                    let label = it
                        .label
                        .as_deref()
                        .and_then(|l| select(l, item))
                        .map(text_of)
                        .unwrap_or_else(|| field.clone());
                    out.values.push(ParsedValue {
                        package: req.package.clone(),
                        endpoint: endpoint.clone(),
                        label,
                        short: None,
                        group: group.clone(),
                        value: t.apply(select(&it.price, item), out.spot),
                        concept: None,
                        field,
                    });
                }
            }
        }
    }
    out
}

pub fn level_key(source: &str, package: &str, field: &str) -> String {
    format!("{source}.{}.{field}", slug(package))
}

pub fn to_level(
    source: &str,
    vendor: &str,
    basis: &str,
    instrument: &InstrumentId,
    as_of: Timestamp,
    v: &ParsedValue,
) -> Level {
    Level {
        key: level_key(source, &v.package, &v.field),
        instrument: instrument.clone(),
        label: v.label.clone(),
        short: v.short.clone(),
        group: v.group.clone(),
        price: v.value.as_ref().ok().map(|d| Price(d.normalize())),
        unavailable_reason: v.value.as_ref().err().cloned(),
        native_price: None,
        source: VendorRef {
            vendor: vendor.to_owned(),
            package: v.package.clone(),
            field: v.field.clone(),
            basis: basis.to_owned(),
            endpoint: Some(v.endpoint.clone()),
            as_of,
            conversion: None,
        },
        concept: v.concept.clone(),
    }
}

pub fn convert(level: &Level, rec: &ConversionRecord, spec: Option<&ContractSpec>) -> Level {
    if let Some(spec) = spec
        && let Ok(l) = rec.convert_level(level, spec)
    {
        return l;
    }
    let mut out = level.clone();
    out.instrument = rec.to.clone();
    out.native_price = level.price.or(level.native_price);
    out.price = level.price.map(|p| {
        Price(
            rec.apply(p.0)
                .round_dp_with_strategy(4, RoundingStrategy::MidpointAwayFromZero),
        )
    });
    out.source.conversion = Some(rec.to_ref());
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn req() -> RequestSpec {
        serde_json::from_value(json!({
            "id": "classic", "package": "Classic", "endpoint": "classic/gex_full",
            "path": "/{ticker}/classic/gex_full",
            "asOf": {"path": "timestamp"}, "spot": "spot", "group": "gamma",
            "fields": [
                {"field": "zero_gamma", "label": "Zero Gamma", "short": "ZG",
                 "concept": {"concept": "gamma_flip", "equivalence": "alias"}},
                {"field": "major_pos_oi", "label": "Major Positive OI", "naIf": [0]},
                {"field": "spot_scaled", "path": "spot", "scale": 0.5, "offset": 1},
                {"field": "em_up", "path": "em", "unit": "offset"},
                {"field": "gone"}
            ],
            "items": {"path": "extra", "field": "name", "price": "value", "label": "title"}
        }))
        .unwrap()
    }

    #[test]
    fn a_response_reads_into_values_with_reasons() {
        let body = json!({
            "timestamp": 1791486350, "spot": 30683.32, "zero_gamma": 30776.18,
            "major_pos_oi": 0, "em": 120.5,
            "extra": [{"name": "hvl", "value": "30650.5", "title": "HVL"}, {"name": "zero_gamma", "value": 1}, {"value": 2}]
        });
        let p = parse(&req(), &body);
        assert_eq!(p.as_of, Some(Timestamp::from_secs(1_791_486_350)));
        assert_eq!(p.spot, Some(Decimal::from_str("30683.32").unwrap()));
        let v = |f: &str| p.values.iter().find(|v| v.field == f).unwrap().clone();
        assert_eq!(
            v("zero_gamma").value,
            Ok(Decimal::from_str("30776.18").unwrap())
        );
        assert_eq!(v("zero_gamma").endpoint, "classic/gex_full");
        assert_eq!(v("zero_gamma").group, "gamma");
        assert_eq!(
            v("major_pos_oi").value,
            Err("the vendor marks it not applicable".into())
        );
        assert_eq!(
            v("spot_scaled").value,
            Ok(Decimal::from_str("15342.66").unwrap())
        );
        assert_eq!(v("em_up").value, Ok(Decimal::from_str("30803.82").unwrap()));
        assert_eq!(v("gone").value, Err("missing from the response".into()));
        assert_eq!(v("hvl").label, "HVL");
        assert_eq!(v("hvl").value, Ok(Decimal::from_str("30650.5").unwrap()));
        assert_eq!(
            p.values.iter().filter(|v| v.field == "zero_gamma").count(),
            1
        );
        assert!(p.problems.iter().any(|x| x.contains("gone")));
        assert!(
            p.problems
                .iter()
                .any(|x| x.contains("an item with no name"))
        );

        let ndx = InstrumentId::new("NDX").unwrap();
        let l = to_level(
            "acme",
            "Acme",
            "NDX",
            &ndx,
            p.as_of.unwrap(),
            &v("zero_gamma"),
        );
        assert_eq!(l.key, "acme.classic.zero_gamma");
        assert_eq!(l.source.field, "zero_gamma");
        assert_eq!(l.source.endpoint.as_deref(), Some("classic/gex_full"));
        assert_eq!(l.concept.as_ref().unwrap().concept, "gamma_flip");
        let na = to_level(
            "acme",
            "Acme",
            "NDX",
            &ndx,
            p.as_of.unwrap(),
            &v("major_pos_oi"),
        );
        assert_eq!(na.price, None);
        assert!(na.unavailable_reason.is_some());

        let nq = InstrumentId::new("NQZ6.CME").unwrap();
        let rec = ConversionRecord::model(
            "c",
            "NDX",
            nq.clone(),
            Decimal::ONE,
            Decimal::from_str("141.375").unwrap(),
            "additive",
            "acme",
            Timestamp(0),
        )
        .unwrap();
        let c = convert(&l, &rec, None);
        assert_eq!(c.instrument, nq);
        assert_eq!(
            c.price,
            Some(Price(Decimal::from_str("30917.555").unwrap()))
        );
        assert_eq!(c.native_price, l.price);
        assert!(c.is_converted());
        let c = convert(&na, &rec, None);
        assert_eq!(c.price, None);
    }

    #[test]
    fn numbers_and_times() {
        assert_eq!(number(&json!(1e3)), Some(Decimal::from(1000)));
        assert_eq!(
            number(&json!("12.5")),
            Some(Decimal::from_str("12.5").unwrap())
        );
        assert_eq!(number(&json!("x")), None);
        let ms = TimeField {
            path: "t".into(),
            unit: TimeUnit::Millis,
        };
        assert_eq!(
            time(&ms, &json!({"t": 1500})),
            Some(Timestamp::from_millis(1500))
        );
        let iso = TimeField {
            path: "t".into(),
            unit: TimeUnit::Rfc3339,
        };
        assert_eq!(
            time(&iso, &json!({"t": "2026-10-08T15:05:50-04:00"})),
            Some(Timestamp::from_secs(1_791_486_350))
        );
    }
}
