use rust_decimal::Decimal;
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use ts_rs::TS;

use crate::instrument::{ContractSpec, InstrumentId};
use crate::levels::{ConversionRef, Level};
use crate::money::{Price, Rounding, decimal_number};
use crate::time::Timestamp;

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum ConversionError {
    #[error("conversion prices must be positive")]
    NonPositive,
    #[error("conversion targets {expected}, spec is for {actual}")]
    WrongTarget {
        expected: InstrumentId,
        actual: InstrumentId,
    },
    #[error("level basis {basis} does not match conversion source {from}")]
    WrongBasis { basis: String, from: String },
}

/// A stored conversion: `target = source × ratio + additive`, then rounded to the target's tick.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ConversionRecord {
    /// Record id; converted levels reference it in `source.conversion.id`.
    pub id: String,
    /// Source price space (`NDX`).
    pub from: String,
    /// Target instrument (`NQZ6.CME`).
    pub to: InstrumentId,
    /// Source price observed (a spot ratio); null for a vendor or fixed model.
    pub from_price: Option<Price>,
    /// Target price observed at the same instant (a spot ratio); null for a model.
    pub to_price: Option<Price>,
    /// The multiplier: `to_price / from_price` for a spot ratio (unrounded), the vendor's
    /// `multiplier` for a vendor model.
    #[serde(with = "decimal_number")]
    #[ts(type = "number")]
    #[schemars(with = "f64")]
    pub ratio: Decimal,
    /// Added after the multiplier (`target = source × ratio + additive`); 0 for a spot ratio.
    #[serde(default, with = "decimal_number")]
    #[ts(type = "number")]
    #[schemars(with = "f64")]
    pub additive: Decimal,
    /// Method (`spot_ratio`; a vendor model as the vendor names it: `additive`, `affine`; a fixed
    /// model from a level source's spec: `ratio`, `additive`, `affine`).
    pub method: String,
    /// The vendor's code for the target contract, when it names one (`NQZ6`).
    #[serde(default)]
    pub contract: Option<String>,
    /// Where the observation came from (a provider id, a quote feed).
    pub source: String,
    /// Observation time.
    pub as_of: Timestamp,
}

impl ConversionRecord {
    pub fn spot_ratio(
        id: impl Into<String>,
        from: impl Into<String>,
        from_price: Decimal,
        to: InstrumentId,
        to_price: Decimal,
        source: impl Into<String>,
        as_of: Timestamp,
    ) -> Result<Self, ConversionError> {
        if from_price <= Decimal::ZERO || to_price <= Decimal::ZERO {
            return Err(ConversionError::NonPositive);
        }
        Ok(Self {
            id: id.into(),
            from: from.into(),
            to,
            from_price: Some(Price(from_price)),
            to_price: Some(Price(to_price)),
            ratio: to_price / from_price,
            additive: Decimal::ZERO,
            method: "spot_ratio".into(),
            contract: None,
            source: source.into(),
            as_of,
        })
    }

    #[allow(clippy::too_many_arguments)]
    pub fn model(
        id: impl Into<String>,
        from: impl Into<String>,
        to: InstrumentId,
        multiplier: Decimal,
        additive: Decimal,
        method: impl Into<String>,
        source: impl Into<String>,
        as_of: Timestamp,
    ) -> Result<Self, ConversionError> {
        if multiplier <= Decimal::ZERO {
            return Err(ConversionError::NonPositive);
        }
        Ok(Self {
            id: id.into(),
            from: from.into(),
            to,
            from_price: None,
            to_price: None,
            ratio: multiplier,
            additive,
            method: method.into(),
            contract: None,
            source: source.into(),
            as_of,
        })
    }

    #[must_use]
    pub fn with_contract(mut self, contract: Option<String>) -> Self {
        self.contract = contract;
        self
    }

    #[must_use]
    pub fn retarget(mut self, id: impl Into<String>, to: InstrumentId) -> Self {
        self.id = id.into();
        self.to = to;
        self
    }

    pub fn apply(&self, price: Decimal) -> Decimal {
        price * self.ratio + self.additive
    }

    pub fn convert(&self, price: Decimal, spec: &ContractSpec) -> Result<Price, ConversionError> {
        if spec.instrument != self.to {
            return Err(ConversionError::WrongTarget {
                expected: self.to.clone(),
                actual: spec.instrument.clone(),
            });
        }
        Ok(spec.quantize(self.apply(price), Rounding::Nearest))
    }

    pub fn to_ref(&self) -> ConversionRef {
        ConversionRef {
            id: self.id.clone(),
            from: self.from.clone(),
            to: self.to.to_string(),
            ratio: self.ratio.round_dp(5),
            additive: self.additive.round_dp(4),
            method: self.method.clone(),
            as_of: self.as_of,
        }
    }

    pub fn convert_level(
        &self,
        level: &Level,
        spec: &ContractSpec,
    ) -> Result<Level, ConversionError> {
        if level.source.basis != self.from {
            return Err(ConversionError::WrongBasis {
                basis: level.source.basis.clone(),
                from: self.from.clone(),
            });
        }
        let mut out = level.clone();
        out.instrument = self.to.clone();
        out.native_price = level.price.or(level.native_price);
        out.price = match level.price {
            Some(p) => Some(self.convert(p.0, spec)?),
            None => None,
        };
        out.source.conversion = Some(self.to_ref());
        Ok(out)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::catalog::Catalog;
    use crate::levels::VendorRef;
    use chrono::NaiveDate;
    use std::str::FromStr;

    fn d(s: &str) -> Decimal {
        Decimal::from_str(s).unwrap()
    }

    fn ndx_to_nq() -> (Catalog, ConversionRecord) {
        let cat = Catalog::seed(NaiveDate::from_ymd_opt(2026, 10, 2).unwrap());
        let nq = InstrumentId::new("NQZ6.CME").unwrap();
        let conv = ConversionRecord::spot_ratio(
            "conv_1",
            "NDX",
            d("20598.40"),
            nq,
            d("20641.25"),
            "spot",
            Timestamp(0),
        )
        .unwrap();
        (cat, conv)
    }

    #[test]
    fn ndx_to_nq_matches_the_content_sheet() {
        let (cat, conv) = ndx_to_nq();
        let nq = conv.to.clone();
        let spec = cat.spec(&nq).unwrap();
        assert_eq!(conv.to_ref().ratio, d("1.00208"));
        for (ndx, want) in [
            ("20850", "20893.25"),
            ("20900", "20943.50"),
            ("20610", "20652.75"),
            ("20570", "20612.75"),
            ("20300", "20342.25"),
        ] {
            assert_eq!(conv.convert(d(ndx), spec).unwrap(), Price(d(want)), "{ndx}");
        }
        let qqq = cat.spec(&InstrumentId::new("QQQ").unwrap()).unwrap();
        assert!(matches!(
            conv.convert(d("1"), qqq),
            Err(ConversionError::WrongTarget { .. })
        ));
        assert!(
            ConversionRecord::spot_ratio("x", "NDX", d("0"), nq, d("1"), "s", Timestamp(0))
                .is_err()
        );
    }

    #[test]
    fn convert_level_keeps_identity_and_records_the_conversion() {
        let (cat, conv) = ndx_to_nq();
        let spec = cat.spec(&conv.to).unwrap();
        let ndx = Level {
            key: "acme.classic.zero_gamma".into(),
            instrument: InstrumentId::new("NDX").unwrap(),
            label: "Zero Gamma".into(),
            short: Some("ZG".into()),
            group: "gamma".into(),
            price: Some(Price(d("20610"))),
            unavailable_reason: None,
            native_price: None,
            source: VendorRef {
                vendor: "Acme".into(),
                package: "Classic".into(),
                field: "zero_gamma".into(),
                basis: "NDX".into(),
                endpoint: Some("classic/gex_full".into()),
                as_of: Timestamp(7),
                conversion: None,
            },
            concept: None,
        };
        let nq = conv.convert_level(&ndx, spec).unwrap();
        assert_eq!(nq.instrument, conv.to);
        assert_eq!(nq.price, Some(Price(d("20652.75"))));
        assert_eq!(nq.native_price, Some(Price(d("20610"))));
        assert_eq!(nq.source.field, "zero_gamma");
        assert_eq!(nq.source.endpoint.as_deref(), Some("classic/gex_full"));
        assert_eq!(nq.source.basis, "NDX");
        assert_eq!(nq.source.as_of, Timestamp(7));
        assert_eq!(nq.source.conversion, Some(conv.to_ref()));

        let mut qqq = ndx.clone();
        qqq.source.basis = "QQQ".into();
        assert!(matches!(
            conv.convert_level(&qqq, spec),
            Err(ConversionError::WrongBasis { .. })
        ));

        let mut na = ndx;
        na.price = None;
        na.unavailable_reason = Some("vendor marked n/a".into());
        let out = conv.convert_level(&na, spec).unwrap();
        assert_eq!(out.price, None);
        assert_eq!(out.native_price, None);
    }

    #[test]
    fn record_serializes_with_numbers() {
        let (_, conv) = ndx_to_nq();
        let v = serde_json::to_value(conv.clone()).unwrap();
        assert_eq!(v["fromPrice"], serde_json::json!(20598.4));
        assert_eq!(v["toPrice"], serde_json::json!(20641.25));
        assert_eq!(v["additive"], serde_json::json!(0));
        assert_eq!(v["to"], "NQZ6.CME");
        let back: ConversionRecord = serde_json::from_value(v).unwrap();
        assert_eq!(back.from_price, conv.from_price);
        assert_eq!(back.to_ref().ratio, conv.to_ref().ratio);
    }

    #[test]
    fn a_vendor_model_adds_after_multiplying() {
        let cat = Catalog::seed(NaiveDate::from_ymd_opt(2026, 10, 2).unwrap());
        let nq = InstrumentId::new("NQZ6.CME").unwrap();
        let spec = cat.spec(&nq).unwrap();
        let add = ConversionRecord::model(
            "c",
            "NDX",
            nq.clone(),
            d("1"),
            d("141.37"),
            "additive",
            "acme",
            Timestamp(0),
        )
        .unwrap()
        .with_contract(Some("NQZ6".into()));
        assert_eq!(add.convert(d("30800"), spec).unwrap(), Price(d("30941.25")));
        assert_eq!(add.from_price, None);
        assert_eq!(add.to_ref().additive, d("141.37"));
        let aff = ConversionRecord::model(
            "c",
            "QQQ",
            nq.clone(),
            d("41.2"),
            d("-12.5"),
            "affine",
            "acme",
            Timestamp(0),
        )
        .unwrap();
        assert_eq!(aff.convert(d("600"), spec).unwrap(), Price(d("24707.50")));
        let v = serde_json::to_value(&aff).unwrap();
        assert_eq!(v["fromPrice"], serde_json::Value::Null);
        assert_eq!(v["additive"], serde_json::json!(-12.5));
        let mut old = v.clone();
        old.as_object_mut().unwrap().remove("additive");
        old.as_object_mut().unwrap().remove("contract");
        let back: ConversionRecord = serde_json::from_value(old).unwrap();
        assert_eq!(back.additive, Decimal::ZERO);
        assert!(
            ConversionRecord::model("c", "X", nq, d("0"), d("1"), "affine", "s", Timestamp(0))
                .is_err()
        );
    }
}
