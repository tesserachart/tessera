use chrono::NaiveDate;
use rithmic_rs::rti::ResponseReferenceData;
use rust_decimal::Decimal;
use tessera_core::instrument::{
    AssetClass, ContractSpec, FuturesContractCode, FuturesMonth, Instrument, InstrumentId,
    cme_equity_index_last_trade, cme_equity_index_roll_date,
};
use tessera_core::money::{Currency, Money, Price, Qty, decimal_from_f64};
use tessera_core::products::{Product, product as core_product};
use tessera_core::session::SessionCalendar;
use tessera_core::time::ExchangeTz;

pub const VENUE_TAG: &str = "RITHMIC";

const LISTED: [&str; 12] = [
    "NQ", "ES", "MNQ", "MES", "RTY", "M2K", "YM", "MYM", "CL", "MCL", "GC", "MGC",
];

pub fn listed() -> impl Iterator<Item = &'static Product> {
    LISTED.into_iter().filter_map(core_product)
}

pub fn product(root: &str) -> Option<&'static Product> {
    LISTED
        .iter()
        .any(|r| r.eq_ignore_ascii_case(root))
        .then(|| core_product(root))
        .flatten()
}

fn contract_root(symbol: &str) -> &str {
    let symbol = symbol.trim();
    let head = symbol.trim_end_matches(|c: char| c.is_ascii_digit());
    let digits = symbol.len() - head.len();
    match head.chars().last() {
        Some(m)
            if (1..=2).contains(&digits)
                && FuturesMonth::from_code(m).is_some()
                && head.len() > 1 =>
        {
            &head[..head.len() - 1]
        }
        _ => symbol,
    }
}

pub fn calendar_of(symbol: &str) -> SessionCalendar {
    SessionCalendar::of_cme_root(contract_root(symbol))
}

pub fn instrument_id(symbol: &str, exchange: &str) -> InstrumentId {
    InstrumentId::from_parts(symbol, Some(&format!("{exchange}-{VENUE_TAG}")))
}

pub fn parse_instrument_id(id: &InstrumentId) -> Option<(String, String)> {
    let exchange = id.venue()?.strip_suffix(VENUE_TAG)?.strip_suffix('-')?;
    (!exchange.is_empty()).then(|| (id.symbol().to_owned(), exchange.to_owned()))
}

pub fn parse_contract(code: &str, reference_year: i32) -> Option<FuturesContractCode> {
    if let Some(c) = FuturesContractCode::parse(code, reference_year) {
        return Some(c);
    }
    let code = code.trim().to_ascii_uppercase();
    let prod = listed()
        .filter(|p| code.starts_with(p.root) && p.root.contains(|c: char| c.is_ascii_digit()))
        .max_by_key(|p| p.root.len())?;
    let mut c =
        FuturesContractCode::parse(&format!("X{}", &code[prod.root.len()..]), reference_year)?;
    c.root = prod.root.to_owned();
    Some(c)
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Wanted {
    Root(&'static Product),
    Contract { symbol: String, exchange: String },
}

pub fn read_input(input: &str, reference_year: i32) -> Option<Wanted> {
    let s = input.trim().to_ascii_uppercase().replace(' ', "");
    if s.is_empty() {
        return None;
    }
    let (sym, venue) = match s.split_once('.') {
        Some((sym, venue)) => (sym, Some(venue)),
        None => (s.as_str(), None),
    };
    let exchange = venue.map(|v| {
        v.strip_suffix(VENUE_TAG)
            .map_or(v, |e| e.trim_end_matches('-'))
            .to_owned()
    });
    if venue.is_none()
        && let Some(prod) = product(sym)
    {
        return Some(Wanted::Root(prod));
    }
    let code = parse_contract(sym, reference_year)?;
    let exchange = match exchange.filter(|e| !e.is_empty()) {
        Some(e) => e,
        None => product(&code.root)?.exchange.to_owned(),
    };
    Some(Wanted::Contract {
        symbol: code.code(),
        exchange,
    })
}

pub fn parse_yyyymmdd(s: &str) -> Option<NaiveDate> {
    NaiveDate::parse_from_str(s.trim(), "%Y%m%d").ok()
}

fn dec(s: &str) -> Decimal {
    s.parse().unwrap_or(Decimal::ONE)
}

pub fn reference_tick(reference: &ResponseReferenceData) -> Option<Decimal> {
    reference
        .min_qprice_change
        .filter(|t| *t > 0.0)
        .and_then(crate::map::clean)
        .filter(|t| *t > Decimal::ZERO)
}

pub fn spec_from_reference(
    symbol: &str,
    exchange: &str,
    reference: Option<&ResponseReferenceData>,
    is_front: bool,
    reference_year: i32,
) -> (Instrument, ContractSpec) {
    let id = instrument_id(symbol, exchange);
    let code = parse_contract(symbol, reference_year);
    let root = reference
        .and_then(|r| r.product_code.clone())
        .or_else(|| code.as_ref().map(|c| c.root.clone()));
    let prod = root.as_deref().and_then(product);
    let tick = reference
        .and_then(reference_tick)
        .or_else(|| prod.map(|p| dec(p.tick)))
        .unwrap_or(Decimal::ONE);
    let multiplier = reference
        .and_then(|r| r.single_point_value)
        .filter(|v| *v > 0.0)
        .and_then(decimal_from_f64)
        .or_else(|| prod.map(|p| dec(p.point_value)))
        .unwrap_or(Decimal::ONE);
    let price_decimals = reference
        .and_then(|r| r.min_qprice_change_precision)
        .and_then(|d| u32::try_from(d).ok())
        .unwrap_or_else(|| tick.normalize().scale());
    let expiry = reference
        .and_then(|r| r.expiration_date.as_deref())
        .and_then(parse_yyyymmdd);
    let sessions = root
        .as_deref()
        .map_or_else(|| calendar_of(symbol), SessionCalendar::of_cme_root);
    let equity_index = sessions == SessionCalendar::CmeEquityIndex;
    let base_name = prod.map(|p| p.name.to_owned()).or_else(|| {
        reference
            .and_then(|r| r.symbol_name.clone())
            .filter(|n| !n.is_empty())
    });
    let name = match (&base_name, &code) {
        (Some(n), Some(c)) => format!("{n} {} {}", c.month.abbrev(), c.year),
        (Some(n), None) => n.clone(),
        (None, _) => symbol.to_owned(),
    };
    let currency = Currency::Usd;
    let instrument = Instrument {
        id: id.clone(),
        symbol: symbol.to_owned(),
        name,
        asset_class: AssetClass::Future,
        exchange: exchange.to_owned(),
        currency,
        root: root.clone(),
        expiry,
        is_front,
        tradable: true,
    };
    let spec = ContractSpec {
        instrument: id,
        asset_class: AssetClass::Future,
        root,
        tick_size: Price(tick),
        tick_value: Money::new(tick * multiplier, currency),
        multiplier,
        currency,
        price_decimals,
        qty_step: Qty(Decimal::ONE),
        min_qty: Qty(Decimal::ONE),
        sessions,
        tz: ExchangeTz::CHICAGO,
        expiry,
        last_trade: expiry
            .filter(|_| equity_index)
            .map(cme_equity_index_last_trade),
        roll_date: expiry
            .filter(|_| equity_index)
            .map(cme_equity_index_roll_date),
        micro_of: prod.and_then(|p| p.micro_of).map(str::to_owned),
    };
    (instrument, spec)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ids_carry_the_connector_and_round_trip() {
        let id = instrument_id("NQZ6", "CME");
        assert_eq!(id.as_str(), "NQZ6.CME-RITHMIC");
        assert_eq!(id.symbol(), "NQZ6");
        assert_eq!(
            parse_instrument_id(&id),
            Some(("NQZ6".into(), "CME".into()))
        );
        assert_eq!(
            parse_instrument_id(&InstrumentId::new("NQZ6.CME").unwrap()),
            None
        );
        assert_eq!(
            parse_instrument_id(&InstrumentId::new("CLX6.NYMEX-RITHMIC").unwrap()),
            Some(("CLX6".into(), "NYMEX".into()))
        );
    }

    #[test]
    fn reads_roots_contracts_and_ids() {
        let root = |s: &str| match read_input(s, 2026) {
            Some(Wanted::Root(p)) => Some(p.root),
            _ => None,
        };
        let contract = |s: &str| match read_input(s, 2026) {
            Some(Wanted::Contract { symbol, exchange }) => Some(format!("{symbol}.{exchange}")),
            _ => None,
        };
        assert_eq!(root("nq"), Some("NQ"));
        assert_eq!(root("MES"), Some("MES"));
        assert_eq!(root(" cl "), Some("CL"));
        assert_eq!(contract("NQZ6").as_deref(), Some("NQZ6.CME"));
        assert_eq!(contract("nqz26").as_deref(), Some("NQZ6.CME"));
        assert_eq!(contract("GCZ6").as_deref(), Some("GCZ6.COMEX"));
        assert_eq!(contract("YMZ6").as_deref(), Some("YMZ6.CBOT"));
        assert_eq!(contract("NQZ6.CME").as_deref(), Some("NQZ6.CME"));
        assert_eq!(contract("NQZ6.CME-RITHMIC").as_deref(), Some("NQZ6.CME"));
        assert_eq!(contract("ZBZ6.CBOT").as_deref(), Some("ZBZ6.CBOT"));
        assert_eq!(contract("m2kz6").as_deref(), Some("M2KZ6.CME"));
        assert_eq!(
            parse_contract("M2KH27", 2026).map(|c| (c.root, c.year)),
            Some(("M2K".to_owned(), 2027))
        );
        assert_eq!(parse_contract("M2K", 2026), None);
        assert_eq!(read_input("ZBZ6", 2026), None);
        assert_eq!(read_input("QQQ", 2026), None);
        assert_eq!(read_input("", 2026), None);
    }

    #[test]
    fn spec_falls_back_to_the_product_table() {
        let (i, s) = spec_from_reference("MNQZ6", "CME", None, true, 2026);
        assert_eq!(i.name, "Micro E-mini Nasdaq-100 Dec 2026");
        assert_eq!(s.tick_size, Price(dec("0.25")));
        assert_eq!(s.tick_value.amount, dec("0.50"));
        assert_eq!(s.price_decimals, 2);
        assert_eq!(s.micro_of.as_deref(), Some("NQ"));
        assert_eq!(s.expiry, None);
        let (m2k, _) = spec_from_reference("M2KZ6", "CME", None, true, 2026);
        assert_eq!(m2k.name, "Micro E-mini Russell 2000 Dec 2026");
        let (_, cl) = spec_from_reference("CLX6", "NYMEX", None, false, 2026);
        assert_eq!(cl.tick_value.amount, dec("10"));
        assert_eq!(cl.price_decimals, 2);
    }

    #[test]
    fn each_contract_trades_on_its_products_calendar() {
        let sessions = |symbol: &str, exchange: &str| {
            spec_from_reference(symbol, exchange, None, false, 2026).1
        };
        let nq = sessions("NQZ6", "CME");
        assert_eq!(nq.sessions, SessionCalendar::CmeEquityIndex);
        assert!(nq.last_trade.is_none(), "no expiry without reference data");
        assert_eq!(
            sessions("MYMZ6", "CBOT").sessions,
            SessionCalendar::CmeEquityIndex
        );
        assert_eq!(
            sessions("CLX6", "NYMEX").sessions,
            SessionCalendar::CmeEnergy
        );
        assert_eq!(
            sessions("MGCZ6", "COMEX").sessions,
            SessionCalendar::CmeGold
        );
        assert_eq!(
            sessions("ZNZ6", "CBOT").sessions,
            SessionCalendar::CmeInterestRates
        );
        assert_eq!(sessions("6EZ6", "CME").sessions, SessionCalendar::CmeFx);
        assert_eq!(sessions("LEZ6", "CME").sessions, SessionCalendar::CmeGlobex);
        assert_eq!(calendar_of("CLX6"), SessionCalendar::CmeEnergy);
        assert_eq!(calendar_of("M2KH27"), SessionCalendar::CmeEquityIndex);
        assert_eq!(calendar_of("GC"), SessionCalendar::CmeGold);
        assert_eq!(calendar_of("XYZ"), SessionCalendar::CmeGlobex);
    }
}
