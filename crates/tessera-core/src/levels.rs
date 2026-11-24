use rust_decimal::Decimal;
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use ts_rs::TS;

use crate::instrument::InstrumentId;
use crate::money::{Price, decimal_number};
use crate::time::Timestamp;

/// Reference to a stored price conversion (e.g. NDX → NQZ6 spot ratio).
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ConversionRef {
    /// Conversion record id.
    pub id: String,
    /// Source price space (`NDX`).
    pub from: String,
    /// Target instrument (`NQZ6.CME`).
    pub to: String,
    /// Multiplier applied to prices (never to magnitudes).
    #[serde(with = "decimal_number")]
    #[ts(type = "number")]
    #[schemars(with = "f64")]
    pub ratio: Decimal,
    /// Added after the multiplier: `price = native × ratio + additive` (0 for a spot ratio).
    #[serde(default, with = "decimal_number")]
    #[ts(type = "number")]
    #[schemars(with = "f64")]
    pub additive: Decimal,
    /// Method (`spot_ratio`, or the model: `additive`, `affine`, `ratio`).
    pub method: String,
    /// When the ratio was observed.
    pub as_of: Timestamp,
}

/// Where a level came from, in the vendor's own terms.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct VendorRef {
    /// Vendor (`Acme`, `Tessera` for computed levels).
    pub vendor: String,
    /// Package or product (`Classic`, `State`, `concepts`).
    pub package: String,
    /// Vendor field name, verbatim (`zero_gamma`, `major_pos_vol`).
    pub field: String,
    /// Price space the value was computed in (`NDX`, `QQQ`, `SPX`).
    pub basis: String,
    /// The vendor request the value came from, in the vendor's terms, when it matters to what the
    /// value means (`classic/gex_full`, `state/gamma_zero`).
    #[serde(default)]
    pub endpoint: Option<String>,
    /// When the vendor value was valid.
    pub as_of: Timestamp,
    /// Conversion applied to reach the displayed price, if any.
    pub conversion: Option<ConversionRef>,
}

/// How a normalized concept relates to the vendor field.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum Equivalence {
    /// Same thing under another name.
    Alias,
    /// Similar idea, different definition.
    Analogous,
    /// Not equivalent; shown for orientation only.
    None,
}

/// A normalized-concept annotation on a vendor level.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ConceptAnnotation {
    /// Concept id (`gamma_flip`).
    pub concept: String,
    /// Relationship to the vendor field.
    pub equivalence: Equivalence,
}

/// A horizontal level on an instrument.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct Level {
    /// Stable key: `<source>.<package>.<field>` (`acme.classic.zero_gamma`,
    /// `tessera.concepts.pdh`). Level settings are kept by it.
    pub key: String,
    /// Instrument the price applies to.
    pub instrument: InstrumentId,
    /// Display label, the vendor's own name (`Zero Gamma`, `Major Positive Volume`).
    pub label: String,
    /// Short tag (`ZG`).
    pub short: Option<String>,
    /// Group (`gamma`, `pd`, `on`, `or`, `ib`, `va`).
    pub group: String,
    /// Price in the instrument's price space; `None` when the vendor marks it not applicable.
    pub price: Option<Price>,
    /// Why there is no price, when `price` is `None`.
    pub unavailable_reason: Option<String>,
    /// The vendor's native value before conversion.
    pub native_price: Option<Price>,
    /// Provenance.
    pub source: VendorRef,
    /// Optional normalized-concept annotation.
    pub concept: Option<ConceptAnnotation>,
}

impl Level {
    pub fn is_converted(&self) -> bool {
        self.source.conversion.is_some()
    }

    pub fn vendor_chip(&self) -> String {
        format!("{} · {}", self.source.vendor, self.source.package)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::str::FromStr;

    #[test]
    fn level_keeps_vendor_identity() {
        let lvl = Level {
            key: "acme.classic.major_pos_vol".into(),
            instrument: InstrumentId::new("NQZ6.CME").unwrap(),
            label: "Major Positive Volume".into(),
            short: Some("MPV".into()),
            group: "gamma".into(),
            price: Some(Price(Decimal::from_str("20943.50").unwrap())),
            unavailable_reason: None,
            native_price: Some(Price(Decimal::from(20900))),
            source: VendorRef {
                vendor: "Acme".into(),
                package: "Classic".into(),
                field: "major_pos_vol".into(),
                basis: "NDX".into(),
                endpoint: Some("classic/gex_full".into()),
                as_of: Timestamp(0),
                conversion: Some(ConversionRef {
                    id: "conv_1".into(),
                    from: "NDX".into(),
                    to: "NQZ6.CME".into(),
                    ratio: Decimal::from_str("1.00208").unwrap(),
                    additive: Decimal::ZERO,
                    method: "spot_ratio".into(),
                    as_of: Timestamp(0),
                }),
            },
            concept: Some(ConceptAnnotation {
                concept: "positive_gex_extreme".into(),
                equivalence: Equivalence::Alias,
            }),
        };
        assert!(lvl.is_converted());
        assert_eq!(lvl.vendor_chip(), "Acme · Classic");
        let v = serde_json::to_value(&lvl).unwrap();
        assert_eq!(v["source"]["field"], "major_pos_vol");
        assert_eq!(
            v["source"]["conversion"]["ratio"],
            serde_json::json!(1.00208)
        );
    }
}
