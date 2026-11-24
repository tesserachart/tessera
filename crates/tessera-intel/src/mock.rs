use std::str::FromStr;

use async_trait::async_trait;
use rust_decimal::Decimal;
use tessera_core::capabilities::IntelCapabilities;
use tessera_core::catalog::Catalog;
use tessera_core::health::{HealthStatus, ProviderHealth, ProviderKind};
use tessera_core::levels::{ConceptAnnotation, Equivalence, Level, VendorRef};
use tessera_core::{InstrumentId, Price, Timestamp};

use crate::io::{DeclaredLevel, DeclaredPackage, LevelSourceInfo};
use crate::source::spec::{LevelColor, LevelLine, StyleHint};
use crate::{ConversionRecord, IntelError, IntelligenceProvider, LevelSnapshot};
use tessera_core::ids::slug;

pub const MOCK_GAMMA_ID: &str = "mock-gamma";
pub const VENDOR: &str = "Mock";
const PACKAGE: &str = "Gamma";
const ENDPOINT: &str = "gamma";
const GROUP: &str = "gamma";

const QQQ_LEVELS: [&str; 5] = ["485.40", "492.00", "480.00", "490.00", "484.90"];
const NDX_LEVELS: [&str; 5] = ["20610", "20850", "20300", "20900", "20570"];

struct Field {
    field: &'static str,
    label: &'static str,
    short: &'static str,
    concept: &'static str,
    color: LevelColor,
    line: LevelLine,
}

const FIELDS: [Field; 5] = [
    Field {
        field: "zero_gamma",
        label: "Zero Gamma",
        short: "ZG",
        concept: "gamma_flip",
        color: LevelColor::Mist,
        line: LevelLine::Dash,
    },
    Field {
        field: "major_pos_vol",
        label: "Major Positive Volume",
        short: "MPV",
        concept: "positive_gex_extreme",
        color: LevelColor::Up,
        line: LevelLine::Solid,
    },
    Field {
        field: "major_neg_vol",
        label: "Major Negative Volume",
        short: "MNV",
        concept: "negative_gex_extreme",
        color: LevelColor::Down,
        line: LevelLine::Solid,
    },
    Field {
        field: "major_pos_oi",
        label: "Major Positive OI",
        short: "MPO",
        concept: "positive_gex_extreme",
        color: LevelColor::Up,
        line: LevelLine::Dot,
    },
    Field {
        field: "major_neg_oi",
        label: "Major Negative OI",
        short: "MNO",
        concept: "negative_gex_extreme",
        color: LevelColor::Down,
        line: LevelLine::Dot,
    },
];

fn package_key() -> String {
    format!("{MOCK_GAMMA_ID}.{}", slug(PACKAGE))
}

fn concept(f: &Field) -> ConceptAnnotation {
    ConceptAnnotation {
        concept: f.concept.to_owned(),
        equivalence: Equivalence::Analogous,
    }
}

#[derive(Clone, Debug)]
pub struct MockGamma {
    catalog: Catalog,
    as_of: Timestamp,
}

impl MockGamma {
    pub fn new(catalog: Catalog, as_of: Timestamp) -> Self {
        Self { catalog, as_of }
    }

    fn native(&self, basis: &str, values: &[&str; 5], instrument: &InstrumentId) -> Vec<Level> {
        FIELDS
            .iter()
            .zip(values)
            .map(|(f, v)| Level {
                key: format!("{}.{}", package_key(), f.field),
                instrument: instrument.clone(),
                label: f.label.to_owned(),
                short: Some(f.short.to_owned()),
                group: GROUP.into(),
                price: Decimal::from_str(v).ok().map(Price),
                unavailable_reason: None,
                native_price: None,
                source: VendorRef {
                    vendor: VENDOR.into(),
                    package: PACKAGE.into(),
                    field: f.field.to_owned(),
                    basis: basis.to_owned(),
                    endpoint: Some(ENDPOINT.into()),
                    as_of: self.as_of,
                    conversion: None,
                },
                concept: Some(concept(f)),
            })
            .collect()
    }

    fn ndx_to(&self, to: &InstrumentId) -> Result<ConversionRecord, IntelError> {
        let d = |s: &str| Decimal::from_str(s).unwrap_or_default();
        ConversionRecord::spot_ratio(
            format!("mock-ndx-{}", to.symbol().to_ascii_lowercase()),
            "NDX",
            d("20598.40"),
            to.clone(),
            d("20641.25"),
            "mock spot ratio",
            self.as_of,
        )
        .map_err(|e| IntelError::Unavailable(e.to_string()))
    }
}

#[async_trait]
impl IntelligenceProvider for MockGamma {
    fn id(&self) -> &str {
        MOCK_GAMMA_ID
    }

    fn display_name(&self) -> &str {
        "Mock gamma levels"
    }

    fn capabilities(&self) -> IntelCapabilities {
        IntelCapabilities {
            vendor: VENDOR.into(),
            packages: vec![PACKAGE.into()],
            levels: true,
            profiles: false,
            conversions: true,
            history: false,
            realtime: false,
            rth_only: true,
        }
    }

    fn health(&self) -> ProviderHealth {
        ProviderHealth {
            provider_id: self.id().to_owned(),
            kind: ProviderKind::Intelligence,
            display_name: self.display_name().to_owned(),
            status: HealthStatus::Ok,
            latency_ms: None,
            last_message_at: Some(self.as_of),
            message: Some("Mock gamma levels for tests".into()),
            connection: None,
            accounts: None,
            checked_at: self.as_of,
        }
    }

    async fn levels(
        &self,
        instrument: &InstrumentId,
        as_of: Option<Timestamp>,
    ) -> Result<LevelSnapshot, IntelError> {
        if let Some(t) = as_of
            && t < self.as_of
        {
            return Err(IntelError::NoSnapshot(t));
        }
        let levels = match instrument.as_str() {
            "QQQ" => self.native("QQQ", &QQQ_LEVELS, instrument),
            "NDX" => self.native("NDX", &NDX_LEVELS, instrument),
            _ => {
                let root = self
                    .catalog
                    .instrument(instrument)
                    .and_then(|i| i.root.clone())
                    .ok_or_else(|| IntelError::NotCovered(instrument.to_string()))?;
                if root != "NQ" && root != "MNQ" {
                    return Err(IntelError::NotCovered(instrument.to_string()));
                }
                let spec = self
                    .catalog
                    .spec(instrument)
                    .ok_or_else(|| IntelError::NotCovered(instrument.to_string()))?;
                let conv = self.ndx_to(instrument)?;
                let ndx = InstrumentId::from_parts("NDX", None);
                self.native("NDX", &NDX_LEVELS, &ndx)
                    .iter()
                    .map(|l| conv.convert_level(l, spec))
                    .collect::<Result<Vec<_>, _>>()
                    .map_err(|e| IntelError::Unavailable(e.to_string()))?
            }
        };
        Ok(LevelSnapshot {
            instrument: instrument.clone(),
            as_of: self.as_of,
            levels,
            raw_blob: None,
        })
    }

    async fn conversion(
        &self,
        from: &str,
        to: &InstrumentId,
    ) -> Result<ConversionRecord, IntelError> {
        let root = self.catalog.instrument(to).and_then(|i| i.root.clone());
        if !from.eq_ignore_ascii_case("NDX") || !matches!(root.as_deref(), Some("NQ" | "MNQ")) {
            return Err(IntelError::NotCovered(format!("{from} → {to}")));
        }
        self.ndx_to(to)
    }

    fn level_source(&self) -> Option<LevelSourceInfo> {
        let key = package_key();
        Some(LevelSourceInfo {
            provider_id: self.id().to_owned(),
            display_name: self.display_name().to_owned(),
            vendor: VENDOR.into(),
            packages: vec![DeclaredPackage {
                levels: FIELDS
                    .iter()
                    .map(|f| DeclaredLevel {
                        key: format!("{key}.{}", f.field),
                        field: f.field.to_owned(),
                        label: f.label.to_owned(),
                        short: Some(f.short.to_owned()),
                        group: GROUP.into(),
                        endpoint: Some(ENDPOINT.into()),
                        description: None,
                        concept: Some(concept(f)),
                        style: Some(StyleHint {
                            color: Some(f.color),
                            line: Some(f.line),
                            on: None,
                        }),
                    })
                    .collect(),
                key,
                vendor: VENDOR.into(),
                package: PACKAGE.into(),
                open: false,
            }],
            instruments: vec!["QQQ".into(), "NDX".into(), "NQ".into(), "MNQ".into()],
            schedule: None,
            calls_today: Vec::new(),
            spec: None,
            editable: false,
            sends_secret: false,
            history: None,
            health: self.health(),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::NaiveDate;

    fn mock() -> MockGamma {
        MockGamma::new(
            Catalog::seed(NaiveDate::from_ymd_opt(2026, 10, 2).unwrap()),
            Timestamp::parse("2026-10-02T14:40:00-04:00").unwrap(),
        )
    }

    #[tokio::test]
    async fn qqq_levels_keep_vendor_identity() {
        let s = mock()
            .levels(&InstrumentId::new("QQQ").unwrap(), None)
            .await
            .unwrap();
        assert_eq!(s.levels.len(), 5);
        let fields: Vec<&str> = s.levels.iter().map(|l| l.source.field.as_str()).collect();
        assert_eq!(
            fields,
            [
                "zero_gamma",
                "major_pos_vol",
                "major_neg_vol",
                "major_pos_oi",
                "major_neg_oi"
            ]
        );
        let mpo = &s.levels[3];
        assert_eq!(mpo.label, "Major Positive OI");
        assert_eq!(mpo.key, "mock-gamma.gamma.major_pos_oi");
        assert_eq!(mpo.price, Some(Price(Decimal::from(490))));
        assert_eq!(mpo.vendor_chip(), "Mock · Gamma");
        assert_eq!(mpo.source.basis, "QQQ");
        assert_eq!(mpo.source.endpoint.as_deref(), Some("gamma"));
        assert!(!mpo.is_converted());
        assert_eq!(
            s.levels[0].concept.as_ref().map(|c| c.equivalence),
            Some(Equivalence::Analogous)
        );
        let info = mock().level_source().unwrap();
        assert_eq!(info.packages[0].key, "mock-gamma.gamma");
        assert_eq!(
            info.packages[0].levels[0].key,
            "mock-gamma.gamma.zero_gamma"
        );
    }

    #[tokio::test]
    async fn conversion_records_resolve_the_level_refs() {
        let g = mock();
        let nq = InstrumentId::new("NQZ6.CME").unwrap();
        let s = g.levels(&nq, None).await.unwrap();
        let rec = g.conversion("NDX", &nq).await.unwrap();
        assert_eq!(rec.to, nq);
        assert_eq!(
            rec.from_price,
            Some(Price(Decimal::from_str("20598.40").unwrap()))
        );
        assert_eq!(
            rec.to_price,
            Some(Price(Decimal::from_str("20641.25").unwrap()))
        );
        for l in &s.levels {
            assert_eq!(l.source.conversion.as_ref(), Some(&rec.to_ref()));
        }
        let mnq = InstrumentId::new("MNQZ6.CME").unwrap();
        let m = g.levels(&mnq, None).await.unwrap();
        assert_eq!(m.levels.len(), 5);
        assert_eq!(
            m.levels[0]
                .source
                .conversion
                .as_ref()
                .map(|c| c.id.as_str()),
            Some("mock-ndx-mnqz6")
        );
        let es = InstrumentId::new("ESZ6.CME").unwrap();
        assert!(matches!(
            g.conversion("NDX", &es).await,
            Err(IntelError::NotCovered(_))
        ));
        assert!(matches!(
            g.conversion("SPX", &nq).await,
            Err(IntelError::NotCovered(_))
        ));
    }

    #[tokio::test]
    async fn nq_levels_are_converted_from_ndx() {
        let g = mock();
        let s = g
            .levels(&InstrumentId::new("NQZ6.CME").unwrap(), None)
            .await
            .unwrap();
        let prices: Vec<String> = s
            .levels
            .iter()
            .map(|l| l.price.unwrap().to_string())
            .collect();
        assert_eq!(
            prices,
            ["20652.75", "20893.25", "20342.25", "20943.50", "20612.75"]
        );
        let zg = &s.levels[0];
        assert_eq!(zg.native_price, Some(Price(Decimal::from(20610))));
        assert_eq!(zg.source.basis, "NDX");
        assert!(zg.is_converted());
        assert!(
            g.levels(&InstrumentId::new("ESZ6.CME").unwrap(), None)
                .await
                .is_err()
        );
        let early = Timestamp::parse("2026-10-02T09:00:00-04:00").unwrap();
        assert!(matches!(
            g.levels(&InstrumentId::new("QQQ").unwrap(), Some(early))
                .await,
            Err(IntelError::NoSnapshot(_))
        ));
    }
}
