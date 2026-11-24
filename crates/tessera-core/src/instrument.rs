use std::borrow::Cow;
use std::fmt;
use std::str::FromStr;

use chrono::{Datelike, Duration, NaiveDate, Weekday};
use rust_decimal::Decimal;
use schemars::{JsonSchema, Schema, SchemaGenerator, json_schema};
use serde::{Deserialize, Deserializer, Serialize, Serializer};
use ts_rs::TS;

use crate::money::{
    Currency, Money, Price, Qty, Rounding, TickError, decimal_number, is_on_tick, quantize,
    ticks_in,
};
use crate::session::SessionCalendar;
use crate::time::{ExchangeTz, Timestamp, local_to_timestamp};

#[derive(Clone, Debug, PartialEq, Eq, PartialOrd, Ord, Hash, TS)]
#[ts(type = "string")]
pub struct InstrumentId(String);

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
#[error("invalid instrument id {0:?}: expected SYMBOL or SYMBOL.VENUE using A-Z 0-9 - _ /")]
pub struct InstrumentIdError(pub String);

impl InstrumentId {
    pub fn new(s: impl AsRef<str>) -> Result<Self, InstrumentIdError> {
        let norm = s.as_ref().trim().to_ascii_uppercase();
        let valid_part = |p: &str| {
            !p.is_empty()
                && p.chars()
                    .all(|c| c.is_ascii_uppercase() || c.is_ascii_digit() || "-_/".contains(c))
                && p.chars().next().is_some_and(|c| c.is_ascii_alphanumeric())
        };
        let ok = match norm.split_once('.') {
            Some((sym, venue)) => valid_part(sym) && valid_part(venue) && !venue.contains('.'),
            None => valid_part(&norm),
        };
        if ok && norm.len() <= 64 {
            Ok(Self(norm))
        } else {
            Err(InstrumentIdError(s.as_ref().to_owned()))
        }
    }

    pub fn from_parts(symbol: &str, venue: Option<&str>) -> Self {
        let s = match venue {
            Some(v) => format!("{symbol}.{v}"),
            None => symbol.to_owned(),
        };
        let id = Self::new(&s);
        debug_assert!(id.is_ok(), "invalid instrument id parts {s}");
        id.unwrap_or(Self(s))
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }

    pub fn symbol(&self) -> &str {
        self.0.split_once('.').map_or(self.0.as_str(), |(s, _)| s)
    }

    pub fn venue(&self) -> Option<&str> {
        self.0.split_once('.').map(|(_, v)| v)
    }
}

impl fmt::Display for InstrumentId {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

impl FromStr for InstrumentId {
    type Err = InstrumentIdError;
    fn from_str(s: &str) -> Result<Self, Self::Err> {
        Self::new(s)
    }
}

impl Serialize for InstrumentId {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_str(&self.0)
    }
}

impl<'de> Deserialize<'de> for InstrumentId {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let s = String::deserialize(deserializer)?;
        Self::new(&s).map_err(serde::de::Error::custom)
    }
}

impl JsonSchema for InstrumentId {
    fn inline_schema() -> bool {
        true
    }

    fn schema_name() -> Cow<'static, str> {
        Cow::Borrowed("InstrumentId")
    }

    fn json_schema(_: &mut SchemaGenerator) -> Schema {
        json_schema!({
            "type": "string",
            "description": "Instrument id: SYMBOL or SYMBOL.VENUE, e.g. QQQ, NQZ6.CME, BTC-USD.COINBASE. Use market.search_instruments to resolve names like NQ or BTC.",
            "pattern": "^[A-Za-z0-9][A-Za-z0-9_/-]*(\\.[A-Za-z0-9][A-Za-z0-9_/-]*)?$"
        })
    }
}

/// Broad asset class.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum AssetClass {
    /// Single stock.
    Equity,
    /// Exchange-traded fund.
    Etf,
    /// Index (not directly tradable).
    Index,
    /// Futures contract (dated).
    Future,
    /// Crypto spot pair.
    Crypto,
    /// Listed option.
    Option,
}

/// Static description of a tradable (or reference) instrument.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct Instrument {
    /// Identifier.
    pub id: InstrumentId,
    /// Display symbol (`QQQ`, `NQZ6`, `BTC-USD`).
    pub symbol: String,
    /// Long name (`Invesco QQQ Trust`, `E-mini Nasdaq-100 Dec 2026`).
    pub name: String,
    /// Asset class.
    pub asset_class: AssetClass,
    /// Listing exchange or venue (`NASDAQ`, `CME`, `COINBASE`).
    pub exchange: String,
    /// Quote currency.
    pub currency: Currency,
    /// Futures root (`NQ`), if a futures contract.
    pub root: Option<String>,
    /// Expiry date of a dated contract.
    #[ts(type = "string | null")]
    pub expiry: Option<NaiveDate>,
    /// True for the front (most active) contract of its root at catalog build time.
    pub is_front: bool,
    /// False for reference-only instruments such as indices.
    pub tradable: bool,
}

/// Contract specification: everything needed for tick math, P&L and sessions.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ContractSpec {
    /// Instrument this spec belongs to.
    pub instrument: InstrumentId,
    /// Asset class.
    pub asset_class: AssetClass,
    /// Futures root (`NQ`, `MNQ`).
    pub root: Option<String>,
    /// Minimum price increment.
    pub tick_size: Price,
    /// Value of one tick for one unit (NQ: $5.00).
    pub tick_value: Money,
    /// Point value: money per 1.0 price move per unit (NQ 20, MNQ 2, ES 50, MES 5, stocks 1).
    #[serde(with = "decimal_number")]
    #[ts(type = "number")]
    #[schemars(with = "f64")]
    pub multiplier: Decimal,
    /// Settlement currency.
    pub currency: Currency,
    /// Decimal places to render prices with.
    pub price_decimals: u32,
    /// Quantity increment.
    pub qty_step: Qty,
    /// Minimum order quantity.
    pub min_qty: Qty,
    /// Session calendar.
    pub sessions: SessionCalendar,
    /// Exchange time zone.
    pub tz: ExchangeTz,
    /// Expiry date of a dated contract.
    #[ts(type = "string | null")]
    pub expiry: Option<NaiveDate>,
    /// Last trading instant of a dated contract.
    pub last_trade: Option<Timestamp>,
    /// Date Tessera rolls front-month views to the next contract.
    #[ts(type = "string | null")]
    pub roll_date: Option<NaiveDate>,
    /// For micro contracts: the full-size root they mirror (`NQ` for `MNQ`).
    pub micro_of: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum SpecError {
    #[error("price {price} is not a multiple of tick {tick}")]
    OffTick { price: Decimal, tick: Decimal },
    #[error("quantity {qty} invalid: min {min}, step {step}")]
    BadQty {
        qty: Decimal,
        min: Decimal,
        step: Decimal,
    },
    #[error(transparent)]
    Tick(#[from] TickError),
}

impl ContractSpec {
    pub fn quantize(&self, price: Decimal, mode: Rounding) -> Price {
        Price(quantize(price, self.tick_size.0, mode).unwrap_or(price))
    }

    pub fn is_on_tick(&self, price: Price) -> bool {
        is_on_tick(price.0, self.tick_size.0)
    }

    pub fn check_price(&self, price: Price) -> Result<(), SpecError> {
        if self.is_on_tick(price) {
            Ok(())
        } else {
            Err(SpecError::OffTick {
                price: price.0,
                tick: self.tick_size.0,
            })
        }
    }

    pub fn check_qty(&self, qty: Qty) -> Result<(), SpecError> {
        let q = qty.0.abs();
        if q < self.min_qty.0 || !is_on_tick(q, self.qty_step.0) {
            return Err(SpecError::BadQty {
                qty: qty.0,
                min: self.min_qty.0,
                step: self.qty_step.0,
            });
        }
        Ok(())
    }

    pub fn ticks_between(&self, from: Price, to: Price) -> Result<i64, SpecError> {
        Ok(ticks_in(to.0 - from.0, self.tick_size.0)?)
    }

    pub fn value_of_points(&self, points: Decimal, qty: Qty) -> Money {
        Money::new(points * qty.0 * self.multiplier, self.currency)
    }

    pub fn pnl(&self, qty: Qty, entry: Price, exit: Price) -> Money {
        self.value_of_points(exit.0 - entry.0, qty)
    }

    pub fn notional(&self, qty: Qty, price: Price) -> Money {
        Money::new(qty.0.abs() * price.0 * self.multiplier, self.currency)
    }

    pub fn earliest_bar(&self, reference_year: i32) -> Option<Timestamp> {
        if self.asset_class != AssetClass::Future {
            return None;
        }
        let symbol = self.instrument.symbol();
        let name_repeats_after = symbol_year_cycle(symbol)?;
        let month = month_of_contract(symbol, self.root.as_deref(), self.expiry, reference_year)?;
        let namesake_month =
            NaiveDate::from_ymd_opt(month.year - name_repeats_after, month.month.number(), 1)?;
        let after_namesake = namesake_month.checked_add_months(chrono::Months::new(1))?;
        Some(local_to_timestamp(self.sessions.tz(), after_namesake, 0, 0))
    }
}

fn symbol_year_cycle(symbol: &str) -> Option<i32> {
    let digits = symbol.len() - symbol.trim_end_matches(|c: char| c.is_ascii_digit()).len();
    match digits {
        1 => Some(10),
        2 => Some(100),
        _ => None,
    }
}

fn month_of_contract(
    symbol: &str,
    root: Option<&str>,
    expiry: Option<NaiveDate>,
    reference_year: i32,
) -> Option<ContractMonth> {
    let year = expiry.map_or(reference_year, |d| d.year());
    root.and_then(|r| contract_month(symbol, r, year))
        .or_else(|| {
            expiry.and_then(|d| {
                Some(ContractMonth {
                    year: d.year(),
                    month: FuturesMonth::from_number(d.month())?,
                })
            })
        })
}

/// CME month codes.
#[derive(
    Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize, TS, JsonSchema,
)]
pub enum FuturesMonth {
    /// January.
    F,
    /// February.
    G,
    /// March.
    H,
    /// April.
    J,
    /// May.
    K,
    /// June.
    M,
    /// July.
    N,
    /// August.
    Q,
    /// September.
    U,
    /// October.
    V,
    /// November.
    X,
    /// December.
    Z,
}

impl FuturesMonth {
    const ALL: [FuturesMonth; 12] = [
        FuturesMonth::F,
        FuturesMonth::G,
        FuturesMonth::H,
        FuturesMonth::J,
        FuturesMonth::K,
        FuturesMonth::M,
        FuturesMonth::N,
        FuturesMonth::Q,
        FuturesMonth::U,
        FuturesMonth::V,
        FuturesMonth::X,
        FuturesMonth::Z,
    ];

    pub fn number(self) -> u32 {
        self as u32 + 1
    }

    pub fn from_number(m: u32) -> Option<Self> {
        Self::ALL.get(m.checked_sub(1)? as usize).copied()
    }

    pub fn from_code(c: char) -> Option<Self> {
        let i = "FGHJKMNQUVXZ".find(c.to_ascii_uppercase())?;
        Self::ALL.get(i).copied()
    }

    pub fn code(self) -> char {
        "FGHJKMNQUVXZ".as_bytes()[self as usize] as char
    }

    pub fn abbrev(self) -> &'static str {
        [
            "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
        ][self as usize]
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub struct FuturesContractCode {
    pub root: String,
    pub month: FuturesMonth,
    pub year: i32,
}

impl FuturesContractCode {
    pub fn parse(code: &str, reference_year: i32) -> Option<Self> {
        let code = code.trim().to_ascii_uppercase();
        let (root, month, year) = split_contract_code(&code, reference_year)?;
        if root.is_empty() {
            return None;
        }
        Some(Self {
            root: root.to_owned(),
            month,
            year,
        })
    }

    pub fn code(&self) -> String {
        format!(
            "{}{}{}",
            self.root,
            self.month.code(),
            self.year.rem_euclid(10)
        )
    }
}

fn split_contract_code(code: &str, reference_year: i32) -> Option<(&str, FuturesMonth, i32)> {
    let digits_at = code.find(|c: char| c.is_ascii_digit())?;
    let (head, digits) = code.split_at(digits_at);
    if digits.len() > 2 {
        return None;
    }
    let month = FuturesMonth::from_code(head.chars().last()?)?;
    let letters = &head[..head.len() - 1];
    if !letters.chars().all(|c| c.is_ascii_uppercase()) {
        return None;
    }
    let y: i32 = digits.parse().ok()?;
    let year = if digits.len() == 2 {
        2000 + y
    } else {
        let mut cand = reference_year - reference_year.rem_euclid(10) + y;
        if cand < reference_year - 2 {
            cand += 10;
        } else if cand > reference_year + 7 {
            cand -= 10;
        }
        cand
    };
    Some((letters, month, year))
}

impl fmt::Display for FuturesContractCode {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.code())
    }
}

/// An exchange names a dated contract by the month it is for, whatever day it expires: a crude
/// contract expires the month before.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash, TS)]
#[ts(type = "string")]
pub struct ContractMonth {
    pub year: i32,
    pub month: FuturesMonth,
}

impl ContractMonth {
    pub fn parse(s: &str) -> Option<Self> {
        let (y, m) = s.trim().split_once('-')?;
        if y.len() != 4 || m.len() != 2 {
            return None;
        }
        Some(Self {
            year: y.parse().ok()?,
            month: FuturesMonth::from_number(m.parse().ok()?)?,
        })
    }

    pub fn words(&self) -> String {
        format!("{} {}", self.month.abbrev(), self.year)
    }
}

impl fmt::Display for ContractMonth {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{:04}-{:02}", self.year, self.month.number())
    }
}

impl Serialize for ContractMonth {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_str(&self.to_string())
    }
}

impl<'de> Deserialize<'de> for ContractMonth {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let s = String::deserialize(deserializer)?;
        Self::parse(&s).ok_or_else(|| {
            serde::de::Error::custom(format!("invalid contract month {s:?}: expected YYYY-MM"))
        })
    }
}

impl JsonSchema for ContractMonth {
    fn inline_schema() -> bool {
        true
    }

    fn schema_name() -> Cow<'static, str> {
        Cow::Borrowed("ContractMonth")
    }

    fn json_schema(_: &mut SchemaGenerator) -> Schema {
        json_schema!({
            "type": "string",
            "description": "The contract month, YYYY-MM: 2026-12 for the December 2026 contract (NQZ6).",
            "pattern": "^[0-9]{4}-(0[1-9]|1[0-2])$"
        })
    }
}

pub fn contract_month(symbol: &str, root: &str, reference_year: i32) -> Option<ContractMonth> {
    let symbol = symbol.trim().to_ascii_uppercase();
    let rest = symbol.strip_prefix(&root.trim().to_ascii_uppercase())?;
    let (_, month, year) = split_contract_code(rest, reference_year)?;
    Some(ContractMonth { year, month })
}

/// A contract as the exchange lists it, whichever connection names it (decision 0010): its
/// exchange, its root and its contract month. One login's `NQZ6.CME-RITHMIC` and another
/// connection's `NQZ6.CME` are the one exchange contract CME NQ Dec 2026. Two connections' instruments
/// are matched by this, and an instrument of one connection is found by asking that connection for
/// it: an id is never built from another connection's id.
#[derive(Clone, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ExchangeContract {
    /// The listing exchange (`CME`, `CBOT`, `NYMEX`, `NASDAQ`).
    pub exchange: String,
    /// The futures root (`NQ`, `MNQ`); for an undated instrument, its symbol (`QQQ`).
    pub root: String,
    /// The contract month (`2026-12`); null for an undated instrument (a stock, an index, a pair).
    pub expiry: Option<ContractMonth>,
}

impl ExchangeContract {
    pub fn new(exchange: &str, root: &str, expiry: Option<ContractMonth>) -> Self {
        Self {
            exchange: exchange.trim().to_ascii_uppercase(),
            root: root.trim().to_ascii_uppercase(),
            expiry,
        }
    }

    pub fn of(instrument: &Instrument, reference_year: i32) -> Option<Self> {
        let exchange = instrument.exchange.trim();
        if exchange.is_empty() {
            return None;
        }
        let Some(root) = instrument.root.as_deref().filter(|r| !r.trim().is_empty()) else {
            return Some(Self::new(exchange, &instrument.symbol, None));
        };
        let expiry = month_of_contract(
            &instrument.symbol,
            Some(root),
            instrument.expiry,
            reference_year,
        );
        Some(Self::new(exchange, root, expiry))
    }

    #[must_use]
    pub fn with_root(&self, root: &str) -> Self {
        Self::new(&self.exchange, root, self.expiry)
    }
}

impl fmt::Display for ExchangeContract {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match &self.expiry {
            Some(m) => write!(f, "{} {}", self.root, m.words()),
            None => f.write_str(&self.root),
        }
    }
}

pub fn third_friday(year: i32, month: u32) -> NaiveDate {
    NaiveDate::from_weekday_of_month_opt(year, month, Weekday::Fri, 3).expect("third friday")
}

pub fn cme_equity_index_expiry(year: i32, month: FuturesMonth) -> NaiveDate {
    let mut d = third_friday(year, month.number());
    while !SessionCalendar::CmeEquityIndex.is_trade_date(d) {
        d -= Duration::days(1);
    }
    d
}

/// Last trade of a CME equity-index contract: 09:30 ET on expiry (special opening quotation).
pub fn cme_equity_index_last_trade(expiry: NaiveDate) -> Timestamp {
    local_to_timestamp(chrono_tz::Tz::America__New_York, expiry, 9, 30)
}

/// Eight calendar days before expiry: the Thursday of the prior week, CME's published roll
/// convention.
pub fn cme_equity_index_roll_date(expiry: NaiveDate) -> NaiveDate {
    expiry - Duration::days(8)
}

pub fn front_quarterly(date: NaiveDate) -> (i32, FuturesMonth) {
    let mut year = date.year();
    loop {
        for m in [
            FuturesMonth::H,
            FuturesMonth::M,
            FuturesMonth::U,
            FuturesMonth::Z,
        ] {
            let expiry = cme_equity_index_expiry(year, m);
            if date < cme_equity_index_roll_date(expiry) {
                return (year, m);
            }
        }
        year += 1;
    }
}

pub fn next_quarterly(year: i32, month: FuturesMonth) -> (i32, FuturesMonth) {
    match month {
        FuturesMonth::Z => (year + 1, FuturesMonth::H),
        m => {
            let n = (m.number() / 3 + 1) * 3;
            (
                year,
                FuturesMonth::from_number(n).unwrap_or(FuturesMonth::Z),
            )
        }
    }
}

pub fn prev_quarterly(year: i32, month: FuturesMonth) -> (i32, FuturesMonth) {
    match month.number() {
        1..=3 => (year - 1, FuturesMonth::Z),
        n => (
            year,
            FuturesMonth::from_number((n - 1) / 3 * 3).unwrap_or(FuturesMonth::H),
        ),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn d(s: &str) -> Decimal {
        Decimal::from_str(s).unwrap()
    }

    #[test]
    fn instrument_ids() {
        let id = InstrumentId::new("nqz6.cme").unwrap();
        assert_eq!(id.as_str(), "NQZ6.CME");
        assert_eq!(id.symbol(), "NQZ6");
        assert_eq!(id.venue(), Some("CME"));
        assert_eq!(
            InstrumentId::new("BTC-USD.COINBASE").unwrap().symbol(),
            "BTC-USD"
        );
        assert!(InstrumentId::new("").is_err());
        assert!(InstrumentId::new("A.B.C").is_err());
        assert!(InstrumentId::new("QQQ;DROP").is_err());
        assert!(serde_json::from_str::<InstrumentId>("\"bad id\"").is_err());
        assert_eq!(
            serde_json::from_str::<InstrumentId>("\"qqq\"")
                .unwrap()
                .as_str(),
            "QQQ"
        );
    }

    #[test]
    fn contract_codes() {
        let c = FuturesContractCode::parse("NQZ6", 2026).unwrap();
        assert_eq!(
            (c.root.as_str(), c.month, c.year),
            ("NQ", FuturesMonth::Z, 2026)
        );
        assert_eq!(
            FuturesContractCode::parse("MNQH7", 2026).unwrap().year,
            2027
        );
        assert_eq!(FuturesContractCode::parse("ESZ5", 2026).unwrap().year, 2025);
        assert_eq!(
            FuturesContractCode::parse("ESZ29", 2026).unwrap().year,
            2029
        );
        assert!(FuturesContractCode::parse("QQQ", 2026).is_none());
        assert!(FuturesContractCode::parse("NQA6", 2026).is_none());
        assert!(FuturesContractCode::parse("Z6", 2026).is_none());
        assert!(FuturesContractCode::parse("NQZ226", 2026).is_none());
        assert!(FuturesContractCode::parse("M2KZ6", 2026).is_none());
        assert_eq!(c.code(), "NQZ6");
    }

    fn future(
        id: &str,
        symbol: &str,
        root: &str,
        exchange: &str,
        expiry: Option<&str>,
    ) -> Instrument {
        Instrument {
            id: InstrumentId::new(id).unwrap(),
            symbol: symbol.into(),
            name: String::new(),
            asset_class: AssetClass::Future,
            exchange: exchange.into(),
            currency: Currency::Usd,
            root: Some(root.into()),
            expiry: expiry.map(|e| NaiveDate::parse_from_str(e, "%Y-%m-%d").unwrap()),
            is_front: true,
            tradable: true,
        }
    }

    #[test]
    fn exchange_contracts_match_across_connections_by_exchange_root_and_month() {
        let dec = ContractMonth::parse("2026-12").unwrap();
        let plain = future("NQZ6.CME", "NQZ6", "NQ", "CME", Some("2026-12-18"));
        let rithmic = future("NQZ6.CME-RITHMIC", "NQZ6", "NQ", "cme", None);
        let a = ExchangeContract::of(&plain, 2020).unwrap();
        let b = ExchangeContract::of(&rithmic, 2026).unwrap();
        assert_eq!(a, b);
        assert_eq!(a, ExchangeContract::new("CME", "NQ", Some(dec)));
        assert_eq!(a.to_string(), "NQ Dec 2026");
        let march = future("NQH7.CME", "NQH7", "NQ", "CME", Some("2027-03-19"));
        assert_ne!(ExchangeContract::of(&march, 2026).unwrap(), a);
        let micro = future("MNQZ6.CME", "MNQZ6", "MNQ", "CME", Some("2026-12-18"));
        assert_ne!(ExchangeContract::of(&micro, 2026).unwrap(), a);
        let elsewhere = future("NQZ6.EUREX", "NQZ6", "NQ", "EUREX", None);
        assert_ne!(ExchangeContract::of(&elsewhere, 2026).unwrap(), a);
        assert_eq!(
            a.with_root("mnq"),
            ExchangeContract::of(&micro, 2026).unwrap()
        );
        assert_eq!(a.with_root("MNQ").to_string(), "MNQ Dec 2026");
        let m2k = future("M2KH27.CME", "M2KH27", "M2K", "CME", None);
        assert_eq!(
            ExchangeContract::of(&m2k, 2026).unwrap().expiry,
            ContractMonth::parse("2027-03")
        );
        let cl = future("CLF7.NYMEX", "CLF7", "CL", "NYMEX", Some("2026-12-17"));
        assert_eq!(
            ExchangeContract::of(&cl, 2026).unwrap().to_string(),
            "CL Jan 2027"
        );
        let odd = future("NQ-DEC.X", "NQ-DEC", "NQ", "CME", Some("2026-12-18"));
        assert_eq!(ExchangeContract::of(&odd, 2026).unwrap(), a);
        let mut qqq = plain.clone();
        qqq.symbol = "QQQ".into();
        qqq.exchange = "NASDAQ".into();
        qqq.root = None;
        qqq.expiry = None;
        let q = ExchangeContract::of(&qqq, 2026).unwrap();
        assert_eq!(
            (q.root.as_str(), q.expiry, q.to_string()),
            ("QQQ", None, "QQQ".into())
        );
        qqq.exchange = String::new();
        assert_eq!(ExchangeContract::of(&qqq, 2026), None);
    }

    #[test]
    fn contract_months_read_and_write_yyyy_mm() {
        let m = ContractMonth::parse("2027-03").unwrap();
        assert_eq!(
            (m.year, m.month, m.words()),
            (2027, FuturesMonth::H, "Mar 2027".into())
        );
        assert_eq!(
            serde_json::to_value(m).unwrap(),
            serde_json::json!("2027-03")
        );
        assert_eq!(
            serde_json::from_str::<ContractMonth>("\"2027-03\"").unwrap(),
            m
        );
        for bad in ["2027-13", "2027-3", "27-03", "march", ""] {
            assert_eq!(ContractMonth::parse(bad), None, "{bad}");
        }
        assert!(serde_json::from_str::<ContractMonth>("\"2027-00\"").is_err());
        assert_eq!(
            contract_month("NQZ6", "NQ", 2026).unwrap().to_string(),
            "2026-12"
        );
        assert_eq!(contract_month("ESZ6", "NQ", 2026), None);
        assert_eq!(contract_month("NQ", "NQ", 2026), None);
        assert_eq!(contract_month("NQ6", "NQ", 2026), None);
        assert_eq!(
            contract_month("m2kz6", "M2K", 2026).unwrap().to_string(),
            "2026-12"
        );
    }

    #[test]
    fn expiries_and_front_month() {
        assert_eq!(
            cme_equity_index_expiry(2026, FuturesMonth::Z),
            NaiveDate::from_ymd_opt(2026, 12, 18).unwrap()
        );
        assert_eq!(
            cme_equity_index_expiry(2027, FuturesMonth::H),
            NaiveDate::from_ymd_opt(2027, 3, 19).unwrap()
        );
        let oct = NaiveDate::from_ymd_opt(2026, 10, 2).unwrap();
        assert_eq!(front_quarterly(oct), (2026, FuturesMonth::Z));
        let dec10 = NaiveDate::from_ymd_opt(2026, 12, 10).unwrap();
        assert_eq!(front_quarterly(dec10), (2027, FuturesMonth::H));
        let dec9 = NaiveDate::from_ymd_opt(2026, 12, 9).unwrap();
        assert_eq!(front_quarterly(dec9), (2026, FuturesMonth::Z));
        assert_eq!(
            next_quarterly(2026, FuturesMonth::Z),
            (2027, FuturesMonth::H)
        );
        assert_eq!(
            next_quarterly(2027, FuturesMonth::H),
            (2027, FuturesMonth::M)
        );
        assert_eq!(
            next_quarterly(2027, FuturesMonth::U),
            (2027, FuturesMonth::Z)
        );
        assert_eq!(
            prev_quarterly(2027, FuturesMonth::H),
            (2026, FuturesMonth::Z)
        );
        assert_eq!(
            prev_quarterly(2026, FuturesMonth::Z),
            (2026, FuturesMonth::U)
        );
        assert_eq!(
            prev_quarterly(2026, FuturesMonth::M),
            (2026, FuturesMonth::H)
        );
        assert_eq!(
            prev_quarterly(2026, FuturesMonth::Q),
            (2026, FuturesMonth::M)
        );
        for (y, m) in [
            (2026, FuturesMonth::H),
            (2026, FuturesMonth::M),
            (2026, FuturesMonth::U),
            (2026, FuturesMonth::Z),
        ] {
            let (py, pm) = prev_quarterly(y, m);
            assert_eq!(next_quarterly(py, pm), (y, m));
        }
    }

    fn mnq_spec() -> ContractSpec {
        ContractSpec {
            instrument: InstrumentId::new("MNQZ6.CME").unwrap(),
            asset_class: AssetClass::Future,
            root: Some("MNQ".into()),
            tick_size: Price(d("0.25")),
            tick_value: Money::usd(d("0.50")),
            multiplier: d("2"),
            currency: Currency::Usd,
            price_decimals: 2,
            qty_step: Qty(d("1")),
            min_qty: Qty(d("1")),
            sessions: SessionCalendar::CmeEquityIndex,
            tz: ExchangeTz::CHICAGO,
            expiry: None,
            last_trade: None,
            roll_date: None,
            micro_of: Some("NQ".into()),
        }
    }

    #[test]
    fn spec_math_matches_content_sheet() {
        let s = mnq_spec();
        let pnl = s.pnl(Qty(d("2")), Price(d("20546.00")), Price(d("20601.50")));
        assert_eq!(pnl.amount, d("222.00"));
        let open = s.pnl(Qty(d("2")), Price(d("20523.00")), Price(d("20641.25")));
        assert_eq!(open.amount, d("473.00"));
        assert_eq!(
            s.ticks_between(Price(d("20523.00")), Price(d("20641.25")))
                .unwrap(),
            473
        );
        assert!(s.check_price(Price(d("20641.10"))).is_err());
        assert!(s.check_qty(Qty(d("0.5"))).is_err());
        assert!(s.check_qty(Qty(d("-3"))).is_ok());
        assert_eq!(
            s.quantize(d("20641.30"), Rounding::Nearest),
            Price(d("20641.25"))
        );
        assert_eq!(s.tick_value.amount, s.tick_size.0 * s.multiplier);
    }

    #[test]
    fn a_contracts_bars_begin_after_the_namesake_a_symbol_cycle_earlier() {
        let ct = |t: &str| Timestamp::parse(t).unwrap();
        let es = |id: &str, root: &str, expiry: Option<&str>| ContractSpec {
            instrument: InstrumentId::new(id).unwrap(),
            root: Some(root.into()),
            expiry: expiry.map(|e| NaiveDate::parse_from_str(e, "%Y-%m-%d").unwrap()),
            ..mnq_spec()
        };
        let z6 = es("ESZ6.CME-RITHMIC", "ES", Some("2026-12-18"));
        assert_eq!(z6.earliest_bar(2026), Some(ct("2017-01-01T00:00:00-05:00")));
        assert_eq!(
            es("ESZ6.CME-RITHMIC", "ES", None).earliest_bar(2026),
            z6.earliest_bar(2026)
        );
        assert_eq!(
            es("ESH7.CME", "ES", None).earliest_bar(2026),
            Some(ct("2017-04-01T00:00:00-04:00"))
        );
        assert_eq!(
            es("M2KZ6.CME", "M2K", None).earliest_bar(2026),
            z6.earliest_bar(2026)
        );
        assert_eq!(
            es("ESZ26.CME", "ES", None).earliest_bar(2026),
            Some(ct("1927-01-01T00:00:00-05:00"))
        );
        assert_eq!(es("ES.CME", "ES", None).earliest_bar(2026), None);
        let stock = ContractSpec {
            asset_class: AssetClass::Equity,
            ..es("QQQ", "QQQ", None)
        };
        assert_eq!(stock.earliest_bar(2026), None);
    }
}
