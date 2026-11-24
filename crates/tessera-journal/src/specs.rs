use std::str::FromStr;

use rust_decimal::Decimal;
use tessera_core::instrument::{AssetClass, ContractSpec, FuturesMonth, InstrumentId};
use tessera_core::money::{Currency, Money, Price, Qty};
use tessera_core::products::product;
use tessera_core::session::SessionCalendar;
use tessera_core::time::ExchangeTz;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ContractName {
    pub root: String,
    pub month: Option<(FuturesMonth, i32)>,
}

impl ContractName {
    pub fn parse(raw: &str, traded_in_year: i32) -> Option<Self> {
        let up = raw.trim().to_ascii_uppercase();
        let mut parts = up.split_whitespace();
        let first: String = parts
            .next()?
            .chars()
            .filter(char::is_ascii_alphanumeric)
            .collect();
        if first.is_empty() {
            return None;
        }
        if let Some(my) = parts.next()
            && let Some((m, y)) = my.split_once('-')
            && let (Ok(m), Ok(y)) = (m.parse::<u32>(), y.parse::<i32>())
            && let Some(month) = FuturesMonth::from_number(m)
        {
            let year = if y < 100 { 2000 + y } else { y };
            return Some(Self {
                root: first,
                month: Some((month, year)),
            });
        }
        let digits = first.chars().rev().take_while(char::is_ascii_digit).count();
        if (1..=4).contains(&digits) && first.len() > digits + 1 {
            let (head, ys) = first.split_at(first.len() - digits);
            let code = head.chars().last()?;
            if let Some(month) = FuturesMonth::from_code(code) {
                let root = &head[..head.len() - 1];
                if !root.is_empty() && (product(root).is_some() || product(&first).is_none()) {
                    let y: i32 = ys.parse().ok()?;
                    let year = match digits {
                        1 => {
                            let mut c = traded_in_year - traded_in_year.rem_euclid(10) + y;
                            if c < traded_in_year - 2 {
                                c += 10;
                            }
                            c
                        }
                        2 => 2000 + y,
                        _ => y,
                    };
                    return Some(Self {
                        root: root.to_owned(),
                        month: Some((month, year)),
                    });
                }
            }
        }
        Some(Self {
            root: first,
            month: None,
        })
    }

    pub fn instrument(&self) -> InstrumentId {
        let exch = product(&self.root).map(|p| p.exchange);
        let s = match (self.month, exch) {
            (Some((m, y)), Some(e)) => format!("{}{}{}.{e}", self.root, m.code(), y.rem_euclid(10)),
            _ => self.root.clone(),
        };
        InstrumentId::new(&s).unwrap_or_else(|_| InstrumentId::from_parts("UNKNOWN", None))
    }
}

fn dec(s: &str) -> Decimal {
    Decimal::from_str(s).unwrap_or(Decimal::ONE)
}

pub fn fallback_spec(instrument: &InstrumentId, root: &str) -> (ContractSpec, bool) {
    let (tick, mult, known, class, sessions, tz) = match product(root) {
        Some(p) => (
            dec(p.tick),
            dec(p.point_value),
            true,
            AssetClass::Future,
            p.calendar,
            ExchangeTz::CHICAGO,
        ),
        None => (
            Decimal::new(1, 2),
            Decimal::ONE,
            false,
            AssetClass::Equity,
            SessionCalendar::UsEquities,
            ExchangeTz::NEW_YORK,
        ),
    };
    let spec = ContractSpec {
        instrument: instrument.clone(),
        asset_class: class,
        root: known.then(|| root.to_ascii_uppercase()),
        tick_size: Price(tick),
        tick_value: Money::usd(tick * mult),
        multiplier: mult,
        currency: Currency::Usd,
        price_decimals: tick.normalize().scale().max(2),
        qty_step: Qty(Decimal::ONE),
        min_qty: Qty(Decimal::ONE),
        sessions,
        tz,
        expiry: None,
        last_trade: None,
        roll_date: None,
        micro_of: None,
    };
    (spec, known)
}

pub fn display_symbol(instrument: &InstrumentId, spec: Option<&ContractSpec>) -> String {
    if let Some(root) = spec.and_then(|s| s.root.clone()) {
        return root;
    }
    let sym = instrument.as_str().split('.').next().unwrap_or_default();
    match ContractName::parse(sym, 2026) {
        Some(c) if c.month.is_some() && product(&c.root).is_some() => c.root,
        _ => sym.to_owned(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn contract_names() {
        let c = ContractName::parse("MNQM4", 2024).unwrap();
        assert_eq!(c.root, "MNQ");
        assert_eq!(c.month, Some((FuturesMonth::from_code('M').unwrap(), 2024)));
        assert_eq!(c.instrument().as_str(), "MNQM4.CME");
        let n = ContractName::parse("NQ 03-24", 2024).unwrap();
        assert_eq!(n.instrument().as_str(), "NQH4.CME");
        let e = ContractName::parse("6EZ5", 2025).unwrap();
        assert_eq!(
            (e.root.as_str(), e.instrument().as_str()),
            ("6E", "6EZ5.CME")
        );
        assert_eq!(ContractName::parse("ESZ2024", 2024).unwrap().root, "ES");
        let bare = ContractName::parse("MES", 2024).unwrap();
        assert_eq!((bare.root.as_str(), bare.month), ("MES", None));
        assert_eq!(ContractName::parse("QQQ", 2024).unwrap().root, "QQQ");
        let (spec, known) = fallback_spec(&c.instrument(), "MNQ");
        assert!(known);
        assert_eq!(spec.multiplier, Decimal::from(2));
        assert_eq!(
            display_symbol(&InstrumentId::new("NQZ6.CME-RITHMIC").unwrap(), None),
            "NQ"
        );
        assert_eq!(
            display_symbol(&InstrumentId::new("QQQ").unwrap(), None),
            "QQQ"
        );
    }

    #[test]
    fn a_future_falls_back_to_its_own_products_calendar() {
        let calendar = |root: &str| {
            let name = ContractName::parse(&format!("{root}Z6"), 2026).unwrap();
            fallback_spec(&name.instrument(), &name.root).0.sessions
        };
        assert_eq!(calendar("NQ"), SessionCalendar::CmeEquityIndex);
        assert_eq!(calendar("MYM"), SessionCalendar::CmeEquityIndex);
        assert_eq!(calendar("ZN"), SessionCalendar::CmeInterestRates);
        assert_eq!(calendar("CL"), SessionCalendar::CmeEnergy);
        assert_eq!(calendar("6E"), SessionCalendar::CmeFx);
        assert_eq!(calendar("MGC"), SessionCalendar::CmeGold);
        assert_eq!(calendar("SIL"), SessionCalendar::CmeSilver);
        assert_eq!(calendar("HG"), SessionCalendar::CmeCopper);
        assert_eq!(calendar("PL"), SessionCalendar::CmePlatinum);
        assert_eq!(calendar("LE"), SessionCalendar::CmeGlobex);
    }

    #[test]
    fn every_root_the_journal_parses_is_a_future_with_a_paper_margin() {
        for p in tessera_core::products::PRODUCTS {
            let c = ContractName::parse(&format!("{}Z6", p.root), 2026).unwrap();
            assert_eq!(c.root, p.root);
            assert_eq!(
                c.instrument().as_str(),
                format!("{}Z6.{}", p.root, p.exchange)
            );
            let (spec, known) = fallback_spec(&c.instrument(), &c.root);
            assert!(known, "{}", p.root);
            assert_eq!(spec.asset_class, AssetClass::Future, "{}", p.root);
            assert!(
                tessera_core::margin::initial_margin(&c.root).is_some(),
                "{}",
                p.root
            );
        }
        let crude = ContractName::parse("QMZ6", 2026).unwrap();
        assert_eq!(crude.instrument().as_str(), "QMZ6.NYMEX");
        let (copper, _) = fallback_spec(
            &ContractName::parse("MHGZ6", 2026).unwrap().instrument(),
            "MHG",
        );
        assert_eq!(copper.tick_value, Money::usd(Decimal::new(125, 2)));
    }
}
