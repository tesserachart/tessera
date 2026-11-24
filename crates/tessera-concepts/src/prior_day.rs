use tessera_core::levels::{Level, VendorRef};
use tessera_core::market::Bar;
use tessera_core::{InstrumentId, Timestamp};

pub const TESSERA_VENDOR: &str = "Tessera";
pub const CONCEPTS_PACKAGE: &str = "Concepts";
pub const PRIOR_DAY_GROUP: &str = "pd";

pub fn prior_day_levels(
    instrument: &InstrumentId,
    daily: &[Bar],
    last_bar_open: bool,
) -> Option<(Timestamp, Vec<Level>)> {
    let completed = if last_bar_open {
        daily.len().checked_sub(2)?
    } else {
        daily.len().checked_sub(1)?
    };
    let bar = daily[completed];
    let level = |field: &str, label: &str, short: &str, price| Level {
        key: format!("tessera.concepts.{field}"),
        instrument: instrument.clone(),
        label: label.to_owned(),
        short: Some(short.to_owned()),
        group: PRIOR_DAY_GROUP.to_owned(),
        price: Some(price),
        unavailable_reason: None,
        native_price: None,
        source: VendorRef {
            vendor: TESSERA_VENDOR.to_owned(),
            package: CONCEPTS_PACKAGE.to_owned(),
            field: field.to_owned(),
            basis: instrument.symbol().to_owned(),
            endpoint: None,
            as_of: bar.t,
            conversion: None,
        },
        concept: None,
    };
    Some((
        bar.t,
        vec![
            level("pdh", "Prior high", "PDH", bar.h),
            level("pdl", "Prior low", "PDL", bar.l),
            level("pdc", "Prior close", "PDC", bar.c),
        ],
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use rust_decimal::Decimal;
    use tessera_core::{Price, Qty};

    fn bar(t: i64, h: i64, l: i64, c: i64) -> Bar {
        Bar {
            t: Timestamp(t),
            o: Price(Decimal::from(c)),
            h: Price(Decimal::from(h)),
            l: Price(Decimal::from(l)),
            c: Price(Decimal::from(c)),
            v: Qty::from(1),
            bv: None,
        }
    }

    #[test]
    fn the_prior_day_is_the_last_completed_session() {
        let qqq = InstrumentId::new("QQQ").unwrap();
        let daily = [bar(1, 490, 480, 485), bar(2, 495, 484, 488)];
        let (as_of, levels) = prior_day_levels(&qqq, &daily, true).unwrap();
        assert_eq!(as_of, Timestamp(1));
        let prices: Vec<String> = levels
            .iter()
            .map(|l| l.price.unwrap().to_string())
            .collect();
        assert_eq!(prices, ["490", "480", "485"]);
        assert_eq!(levels[0].source.field, "pdh");
        assert_eq!(levels[0].group, "pd");
        assert_eq!(levels[0].vendor_chip(), "Tessera · Concepts");
        let (as_of, _) = prior_day_levels(&qqq, &daily, false).unwrap();
        assert_eq!(as_of, Timestamp(2));
        assert!(prior_day_levels(&qqq, &daily[..1], true).is_none());
        assert!(prior_day_levels(&qqq, &[], false).is_none());
    }
}
