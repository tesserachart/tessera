use std::collections::BTreeMap;
use std::str::FromStr;

use chrono::{Datelike, NaiveDate};
use rust_decimal::Decimal;
use serde::{Deserialize, Serialize};

use crate::instrument::{
    AssetClass, ContractSpec, FuturesContractCode, FuturesMonth, Instrument, InstrumentId,
    cme_equity_index_expiry, cme_equity_index_last_trade, cme_equity_index_roll_date,
    front_quarterly, next_quarterly,
};
use crate::money::{Currency, Money, Price, Qty};
use crate::products::{Product, product};
use crate::session::SessionCalendar;
use crate::time::ExchangeTz;

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct FuturesProduct {
    pub root: String,
    pub name: String,
    pub exchange: String,
    pub tick_size: Decimal,
    pub multiplier: Decimal,
    pub micro_of: Option<String>,
}

impl FuturesProduct {
    fn of(p: &Product) -> Self {
        Self {
            root: p.root.to_owned(),
            name: p.name.to_owned(),
            exchange: p.exchange.to_owned(),
            tick_size: dec(p.tick),
            multiplier: dec(p.point_value),
            micro_of: p.micro_of.map(str::to_owned),
        }
    }

    pub fn contract(
        &self,
        year: i32,
        month: FuturesMonth,
        is_front: bool,
    ) -> (Instrument, ContractSpec) {
        let code = FuturesContractCode {
            root: self.root.clone(),
            month,
            year,
        };
        let id = InstrumentId::from_parts(&code.code(), Some(&self.exchange));
        let expiry = cme_equity_index_expiry(year, month);
        let instrument = Instrument {
            id: id.clone(),
            symbol: code.code(),
            name: format!("{} {} {}", self.name, month.abbrev(), year),
            asset_class: AssetClass::Future,
            exchange: self.exchange.clone(),
            currency: Currency::Usd,
            root: Some(self.root.clone()),
            expiry: Some(expiry),
            is_front,
            tradable: true,
        };
        let spec = ContractSpec {
            instrument: id,
            asset_class: AssetClass::Future,
            root: Some(self.root.clone()),
            tick_size: Price(self.tick_size),
            tick_value: Money::usd(self.tick_size * self.multiplier),
            multiplier: self.multiplier,
            currency: Currency::Usd,
            price_decimals: self.tick_size.scale(),
            qty_step: Qty(Decimal::ONE),
            min_qty: Qty(Decimal::ONE),
            sessions: SessionCalendar::CmeEquityIndex,
            tz: ExchangeTz::CHICAGO,
            expiry: Some(expiry),
            last_trade: Some(cme_equity_index_last_trade(expiry)),
            roll_date: Some(cme_equity_index_roll_date(expiry)),
            micro_of: self.micro_of.clone(),
        };
        (instrument, spec)
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CatalogEntry {
    pub instrument: Instrument,
    pub spec: ContractSpec,
}

#[derive(Clone, Debug, Default)]
pub struct Catalog {
    entries: BTreeMap<InstrumentId, CatalogEntry>,
    products: Vec<FuturesProduct>,
    reference_date: Option<NaiveDate>,
}

fn dec(s: &str) -> Decimal {
    Decimal::from_str(s).expect("valid literal decimal")
}

fn cash_entry(
    symbol: &str,
    name: &str,
    class: AssetClass,
    exchange: &str,
    tradable: bool,
) -> CatalogEntry {
    let id = InstrumentId::from_parts(symbol, None);
    CatalogEntry {
        instrument: Instrument {
            id: id.clone(),
            symbol: symbol.to_owned(),
            name: name.to_owned(),
            asset_class: class,
            exchange: exchange.to_owned(),
            currency: Currency::Usd,
            root: None,
            expiry: None,
            is_front: false,
            tradable,
        },
        spec: ContractSpec {
            instrument: id,
            asset_class: class,
            root: None,
            tick_size: Price(dec("0.01")),
            tick_value: Money::usd(dec("0.01")),
            multiplier: Decimal::ONE,
            currency: Currency::Usd,
            price_decimals: 2,
            qty_step: Qty(Decimal::ONE),
            min_qty: Qty(Decimal::ONE),
            sessions: SessionCalendar::UsEquities,
            tz: ExchangeTz::NEW_YORK,
            expiry: None,
            last_trade: None,
            roll_date: None,
            micro_of: None,
        },
    }
}

fn crypto_entry(base: &str, name: &str) -> CatalogEntry {
    let symbol = format!("{base}-USD");
    let id = InstrumentId::from_parts(&symbol, Some("COINBASE"));
    CatalogEntry {
        instrument: Instrument {
            id: id.clone(),
            symbol,
            name: name.to_owned(),
            asset_class: AssetClass::Crypto,
            exchange: "COINBASE".to_owned(),
            currency: Currency::Usd,
            root: None,
            expiry: None,
            is_front: false,
            tradable: true,
        },
        spec: ContractSpec {
            instrument: id,
            asset_class: AssetClass::Crypto,
            root: None,
            tick_size: Price(dec("0.01")),
            tick_value: Money::usd(dec("0.01")),
            multiplier: Decimal::ONE,
            currency: Currency::Usd,
            price_decimals: 2,
            qty_step: Qty(dec("0.00000001")),
            min_qty: Qty(dec("0.00000001")),
            sessions: SessionCalendar::Crypto24x7,
            tz: ExchangeTz::UTC,
            expiry: None,
            last_trade: None,
            roll_date: None,
            micro_of: None,
        },
    }
}

pub fn seed_futures_products() -> Vec<FuturesProduct> {
    ["NQ", "MNQ", "ES", "MES"]
        .into_iter()
        .filter_map(product)
        .map(FuturesProduct::of)
        .collect()
}

impl Catalog {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn seed(reference_date: NaiveDate) -> Self {
        let mut cat = Catalog {
            reference_date: Some(reference_date),
            ..Catalog::default()
        };
        for e in [
            cash_entry("QQQ", "Invesco QQQ Trust", AssetClass::Etf, "NASDAQ", true),
            cash_entry(
                "SPY",
                "SPDR S&P 500 ETF Trust",
                AssetClass::Etf,
                "NYSE Arca",
                true,
            ),
            cash_entry(
                "NDX",
                "Nasdaq-100 Index",
                AssetClass::Index,
                "NASDAQ",
                false,
            ),
            cash_entry("NVDA", "NVIDIA Corp", AssetClass::Equity, "NASDAQ", true),
            cash_entry("AAPL", "Apple Inc", AssetClass::Equity, "NASDAQ", true),
            cash_entry("TSLA", "Tesla Inc", AssetClass::Equity, "NASDAQ", true),
            crypto_entry("BTC", "Bitcoin / US Dollar"),
            crypto_entry("ETH", "Ether / US Dollar"),
        ] {
            cat.insert(e);
        }
        let (fy, fm) = front_quarterly(reference_date);
        let (ny, nm) = next_quarterly(fy, fm);
        for product in seed_futures_products() {
            for (y, m, front) in [(fy, fm, true), (ny, nm, false)] {
                let (instrument, spec) = product.contract(y, m, front);
                cat.insert(CatalogEntry { instrument, spec });
            }
            cat.products.push(product);
        }
        cat
    }

    pub fn insert(&mut self, entry: CatalogEntry) {
        self.entries.insert(entry.instrument.id.clone(), entry);
    }

    pub fn get(&self, id: &InstrumentId) -> Option<&CatalogEntry> {
        self.entries.get(id)
    }

    pub fn spec(&self, id: &InstrumentId) -> Option<&ContractSpec> {
        self.get(id).map(|e| &e.spec)
    }

    pub fn instrument(&self, id: &InstrumentId) -> Option<&Instrument> {
        self.get(id).map(|e| &e.instrument)
    }

    pub fn entries(&self) -> impl Iterator<Item = &CatalogEntry> {
        self.entries.values()
    }

    pub fn products(&self) -> &[FuturesProduct] {
        &self.products
    }

    pub fn front_contract(&self, root: &str) -> Option<&CatalogEntry> {
        let root = root.to_ascii_uppercase();
        self.entries
            .values()
            .find(|e| e.instrument.root.as_deref() == Some(root.as_str()) && e.instrument.is_front)
    }

    pub fn resolve(&self, input: &str) -> Option<InstrumentId> {
        let q = input.trim().to_ascii_uppercase();
        if q.is_empty() {
            return None;
        }
        if let Ok(id) = InstrumentId::new(&q)
            && self.entries.contains_key(&id)
        {
            return Some(id);
        }
        if let Some(e) = self.entries.values().find(|e| e.instrument.symbol == q) {
            return Some(e.instrument.id.clone());
        }
        if let Some(e) = self.front_contract(&q) {
            return Some(e.instrument.id.clone());
        }
        let compact: String = q.chars().filter(|c| !c.is_whitespace()).collect();
        let year = self.reference_date.map_or(2026, |d| d.year());
        if let Some(code) = FuturesContractCode::parse(&compact, year) {
            let sym = code.code();
            if let Some(e) = self.entries.values().find(|e| e.instrument.symbol == sym) {
                return Some(e.instrument.id.clone());
            }
        }
        let pair = compact.replace(['/', '-'], "");
        let pair = pair.strip_suffix("USD").unwrap_or(&pair).to_owned();
        self.entries
            .values()
            .find(|e| {
                e.instrument.asset_class == AssetClass::Crypto
                    && e.instrument.symbol.split('-').next() == Some(pair.as_str())
            })
            .map(|e| e.instrument.id.clone())
    }

    pub fn search(
        &self,
        query: &str,
        asset_class: Option<AssetClass>,
        limit: usize,
    ) -> Vec<&Instrument> {
        let q = query.trim().to_ascii_uppercase();
        let resolved = self.resolve(&q);
        let mut scored: Vec<(u32, &Instrument)> = self
            .entries
            .values()
            .map(|e| &e.instrument)
            .filter(|i| asset_class.is_none_or(|c| i.asset_class == c))
            .filter_map(|i| {
                let name = i.name.to_ascii_uppercase();
                let score = if q.is_empty() {
                    Some(500)
                } else if resolved.as_ref() == Some(&i.id) {
                    Some(0)
                } else if i.symbol.starts_with(&q) {
                    Some(100 + i.symbol.len() as u32)
                } else if i.root.as_deref() == Some(q.as_str()) {
                    Some(200)
                } else if name.contains(&q) {
                    Some(300)
                } else if i.exchange.to_ascii_uppercase() == q {
                    Some(400)
                } else {
                    None
                }?;
                Some((score + u32::from(!i.is_front && i.root.is_some()), i))
            })
            .collect();
        scored.sort_by(|a, b| a.0.cmp(&b.0).then_with(|| a.1.id.cmp(&b.1.id)));
        scored.into_iter().take(limit).map(|(_, i)| i).collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cat() -> Catalog {
        Catalog::seed(NaiveDate::from_ymd_opt(2026, 10, 2).unwrap())
    }

    #[test]
    fn seed_contains_the_fixture_universe() {
        let c = cat();
        for id in [
            "QQQ",
            "SPY",
            "NDX",
            "NVDA",
            "AAPL",
            "TSLA",
            "NQZ6.CME",
            "NQH7.CME",
            "MNQZ6.CME",
            "ESZ6.CME",
            "MESZ6.CME",
            "BTC-USD.COINBASE",
            "ETH-USD.COINBASE",
        ] {
            assert!(
                c.get(&InstrumentId::new(id).unwrap()).is_some(),
                "{id} missing"
            );
        }
        let nq = c.spec(&InstrumentId::new("NQZ6.CME").unwrap()).unwrap();
        assert_eq!(nq.tick_value.amount, dec("5.00"));
        assert_eq!(nq.multiplier, dec("20"));
        assert_eq!(nq.expiry, NaiveDate::from_ymd_opt(2026, 12, 18));
        let mes = c.spec(&InstrumentId::new("MESZ6.CME").unwrap()).unwrap();
        assert_eq!(mes.tick_value.amount, dec("1.25"));
        assert_eq!(mes.micro_of.as_deref(), Some("ES"));
        assert!(
            !c.instrument(&InstrumentId::new("NDX").unwrap())
                .unwrap()
                .tradable
        );
    }

    #[test]
    fn resolution() {
        let c = cat();
        let r = |s: &str| c.resolve(s).map(|i| i.to_string());
        assert_eq!(r("NQ").as_deref(), Some("NQZ6.CME"));
        assert_eq!(r("mnq").as_deref(), Some("MNQZ6.CME"));
        assert_eq!(r("NQH7").as_deref(), Some("NQH7.CME"));
        assert_eq!(r("nq h7").as_deref(), Some("NQH7.CME"));
        assert_eq!(r("BTCUSD").as_deref(), Some("BTC-USD.COINBASE"));
        assert_eq!(r("btc").as_deref(), Some("BTC-USD.COINBASE"));
        assert_eq!(r("eth/usd").as_deref(), Some("ETH-USD.COINBASE"));
        assert_eq!(r("qqq").as_deref(), Some("QQQ"));
        assert_eq!(r("XYZ"), None);
    }

    #[test]
    fn search_ranking() {
        let c = cat();
        let hits: Vec<_> = c
            .search("NQ", None, 10)
            .iter()
            .map(|i| i.id.to_string())
            .collect();
        assert_eq!(hits[0], "NQZ6.CME");
        assert!(hits.contains(&"NQH7.CME".to_owned()));
        let apple: Vec<_> = c
            .search("apple", None, 5)
            .iter()
            .map(|i| i.symbol.clone())
            .collect();
        assert_eq!(apple, vec!["AAPL"]);
        let crypto = c.search("", Some(AssetClass::Crypto), 10);
        assert_eq!(crypto.len(), 2);
        assert_eq!(c.search("", None, 3).len(), 3);
    }

    #[test]
    fn roll_moves_the_front_month() {
        let c = Catalog::seed(NaiveDate::from_ymd_opt(2026, 12, 11).unwrap());
        assert_eq!(c.resolve("NQ").unwrap().as_str(), "NQH7.CME");
        assert!(c.resolve("NQM7").is_some());
    }
}
