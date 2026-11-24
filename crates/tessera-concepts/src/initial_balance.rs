use chrono::NaiveDate;
use rust_decimal::Decimal;
use tessera_core::initial_balance::InitialBalance;
use tessera_core::levels::{Level, VendorRef};
use tessera_core::{InstrumentId, Price};

use crate::prior_day::{CONCEPTS_PACKAGE, TESSERA_VENDOR};

pub const INITIAL_BALANCE_GROUP: &str = "ib";

pub fn initial_balance_levels(
    instrument: &InstrumentId,
    ib: &InitialBalance,
    today: NaiveDate,
) -> Vec<Level> {
    let half = Decimal::new(5, 1);
    let lines: [(&str, &str, &str, Price); 7] = [
        ("high", "IB high", "IBH", ib.high),
        ("low", "IB low", "IBL", ib.low),
        ("mid", "IB mid", "IBM", ib.mid()),
        ("high50", "IB +50%", "IB+50", ib.above(half)),
        ("low50", "IB −50%", "IB−50", ib.below(half)),
        ("high100", "IB +100%", "IB+100", ib.above(Decimal::ONE)),
        ("low100", "IB −100%", "IB−100", ib.below(Decimal::ONE)),
    ];
    let state = if !ib.complete() {
        format!(" (forming, {} of {} min)", ib.minutes_in(), ib.minutes)
    } else if ib.trade_date != today {
        format!(" ({})", ib.trade_date.format("%a %-d %b"))
    } else {
        String::new()
    };
    lines
        .into_iter()
        .map(|(field, label, short, price)| Level {
            key: format!("tessera.ib.{field}"),
            instrument: instrument.clone(),
            label: format!("{label}{state}"),
            short: Some(short.to_owned()),
            group: INITIAL_BALANCE_GROUP.to_owned(),
            price: Some(price),
            unavailable_reason: None,
            native_price: None,
            source: VendorRef {
                vendor: TESSERA_VENDOR.to_owned(),
                package: CONCEPTS_PACKAGE.to_owned(),
                field: field.to_owned(),
                basis: instrument.symbol().to_owned(),
                endpoint: None,
                as_of: ib.through,
                conversion: None,
            },
            concept: None,
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use tessera_core::Timestamp;
    use tessera_core::time::NANOS_PER_MINUTE;

    fn p(v: &str) -> Price {
        Price(v.parse().unwrap())
    }

    fn ib(through_minutes: i64) -> InitialBalance {
        let start = Timestamp::parse("2026-10-02T09:30:00-04:00").unwrap();
        InitialBalance {
            trade_date: NaiveDate::from_ymd_opt(2026, 10, 2).unwrap(),
            minutes: 30,
            start,
            end: Timestamp(start.0 + 30 * NANOS_PER_MINUTE),
            high: p("20712.50"),
            low: p("20601.75"),
            through: Timestamp(start.0 + through_minutes * NANOS_PER_MINUTE),
        }
    }

    #[test]
    fn a_complete_balance_draws_its_high_low_mid_and_extensions() {
        let nq = InstrumentId::new("NQZ6.CME").unwrap();
        let today = NaiveDate::from_ymd_opt(2026, 10, 2).unwrap();
        let levels = initial_balance_levels(&nq, &ib(30), today);
        let got: Vec<(String, String, String)> = levels
            .iter()
            .map(|l| {
                (
                    l.source.field.clone(),
                    l.label.clone(),
                    l.price.unwrap().to_string(),
                )
            })
            .collect();
        let want = [
            ("high", "IB high", "20712.50"),
            ("low", "IB low", "20601.75"),
            ("mid", "IB mid", "20657.125"),
            ("high50", "IB +50%", "20767.875"),
            ("low50", "IB −50%", "20546.375"),
            ("high100", "IB +100%", "20823.25"),
            ("low100", "IB −100%", "20491.00"),
        ];
        for ((field, label, price), (wf, wl, wp)) in got.iter().zip(want) {
            assert_eq!((field.as_str(), label.as_str()), (wf, wl));
            assert_eq!(p(price), p(wp), "{field}");
        }
        assert!(
            levels
                .iter()
                .all(|l| l.group == "ib" && l.key == format!("tessera.ib.{}", l.source.field))
        );
        assert_eq!(levels[0].vendor_chip(), "Tessera · Concepts");
    }

    #[test]
    fn a_window_still_running_says_so_in_every_label() {
        let nq = InstrumentId::new("NQZ6.CME").unwrap();
        let today = NaiveDate::from_ymd_opt(2026, 10, 2).unwrap();
        let levels = initial_balance_levels(&nq, &ib(12), today);
        assert_eq!(levels[0].label, "IB high (forming, 12 of 30 min)");
        assert!(
            levels
                .iter()
                .all(|l| l.label.ends_with("(forming, 12 of 30 min)"))
        );
        let next_day = NaiveDate::from_ymd_opt(2026, 10, 5).unwrap();
        assert_eq!(
            initial_balance_levels(&nq, &ib(30), next_day)[1].label,
            "IB low (Fri 2 Oct)"
        );
    }
}
