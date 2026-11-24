use crate::session::SessionCalendar;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Product {
    pub root: &'static str,
    pub name: &'static str,
    pub exchange: &'static str,
    pub tick: &'static str,
    pub point_value: &'static str,
    pub initial_margin_usd: i64,
    pub calendar: SessionCalendar,
    pub micro_of: Option<&'static str>,
}

impl Product {
    pub fn micro(&self) -> Option<&'static Product> {
        PRODUCTS.iter().find(|p| p.micro_of == Some(self.root))
    }

    pub fn is_micro(&self) -> bool {
        self.micro_of.is_some()
    }
}

const EQ: SessionCalendar = SessionCalendar::CmeEquityIndex;
const RATES: SessionCalendar = SessionCalendar::CmeInterestRates;
const FX: SessionCalendar = SessionCalendar::CmeFx;
const ENERGY: SessionCalendar = SessionCalendar::CmeEnergy;
const GOLD: SessionCalendar = SessionCalendar::CmeGold;
const SILVER: SessionCalendar = SessionCalendar::CmeSilver;
const COPPER: SessionCalendar = SessionCalendar::CmeCopper;
const PLATINUM: SessionCalendar = SessionCalendar::CmePlatinum;
const GLOBEX: SessionCalendar = SessionCalendar::CmeGlobex;

const fn p(
    root: &'static str,
    name: &'static str,
    exchange: &'static str,
    tick: &'static str,
    point_value: &'static str,
    initial_margin_usd: i64,
    calendar: SessionCalendar,
) -> Product {
    Product {
        root,
        name,
        exchange,
        tick,
        point_value,
        initial_margin_usd,
        calendar,
        micro_of: None,
    }
}

const fn micro(full: &'static str, product: Product) -> Product {
    Product {
        micro_of: Some(full),
        ..product
    }
}

// CME Group exchange initial margins (110% of maintenance), as restated by Discount Trading (discounttrading.com/margin.html) on 2026-10-09.
#[rustfmt::skip]
pub const PRODUCTS: &[Product] = &[
                 p("ES",  "E-mini S&P 500",              "CME",   "0.25",      "50",       25_777, EQ),
                 p("NQ",  "E-mini Nasdaq-100",           "CME",   "0.25",      "20",       45_532, EQ),
                 p("YM",  "E-mini Dow ($5)",             "CBOT",  "1",         "5",        17_027, EQ),
                 p("RTY", "E-mini Russell 2000",         "CME",   "0.1",       "50",       11_239, EQ),
    micro("ES",  p("MES", "Micro E-mini S&P 500",        "CME",   "0.25",      "5",        2_577,  EQ)),
    micro("NQ",  p("MNQ", "Micro E-mini Nasdaq-100",     "CME",   "0.25",      "2",        4_553,  EQ)),
    micro("YM",  p("MYM", "Micro E-mini Dow",            "CBOT",  "1",         "0.5",      1_695,  EQ)),
    micro("RTY", p("M2K", "Micro E-mini Russell 2000",   "CME",   "0.1",       "5",        1_124,  EQ)),
                 p("NKD", "Nikkei 225 (Dollar)",         "CME",   "5",         "5",        27_077, GLOBEX),
                 p("CL",  "Crude Oil",                   "NYMEX", "0.01",      "1000",     10_117, ENERGY),
    micro("CL",  p("MCL", "Micro WTI Crude Oil",         "NYMEX", "0.01",      "100",      1_014,  ENERGY)),
                 p("QM",  "E-mini Crude Oil",            "NYMEX", "0.025",     "500",      5_069,  ENERGY),
                 p("NG",  "Henry Hub Natural Gas",       "NYMEX", "0.001",     "10000",    3_619,  ENERGY),
    micro("NG",  p("MNG", "Micro Henry Hub Natural Gas", "NYMEX", "0.001",     "1000",     364,    GLOBEX)),
                 p("HO",  "NY Harbor ULSD",              "NYMEX", "0.0001",    "42000",    15_225, ENERGY),
                 p("RB",  "RBOB Gasoline",               "NYMEX", "0.0001",    "42000",    8_896,  ENERGY),
                 p("GC",  "Gold",                        "COMEX", "0.1",       "100",      22_864, GOLD),
    micro("GC",  p("MGC", "Micro Gold",                  "COMEX", "0.1",       "10",       2_406,  GOLD)),
                 p("SI",  "Silver",                      "COMEX", "0.005",     "5000",     32_683, SILVER),
    micro("SI",  p("SIL", "Micro Silver",                "COMEX", "0.005",     "500",      6_618,  SILVER)),
                 p("HG",  "Copper",                      "COMEX", "0.0005",    "25000",    13_200, COPPER),
    micro("HG",  p("MHG", "Micro Copper",                "COMEX", "0.0005",    "2500",     1_320,  COPPER)),
                 p("PL",  "Platinum",                    "NYMEX", "0.1",       "50",       8_128,  PLATINUM),
                 p("6A",  "Australian Dollar",           "CME",   "0.0001",    "100000",   1_925,  FX),
                 p("6B",  "British Pound",               "CME",   "0.0001",    "62500",    1_870,  FX),
                 p("6C",  "Canadian Dollar",             "CME",   "0.00005",   "100000",   880,    FX),
                 p("6E",  "Euro FX",                     "CME",   "0.00005",   "125000",   2_310,  FX),
                 p("6J",  "Japanese Yen",                "CME",   "0.0000005", "12500000", 3_080,  FX),
                 p("6M",  "Mexican Peso",                "CME",   "0.000005",  "500000",   1_210,  GLOBEX),
                 p("6N",  "New Zealand Dollar",          "CME",   "0.0001",    "100000",   1_320,  GLOBEX),
                 p("6S",  "Swiss Franc",                 "CME",   "0.0001",    "125000",   3_960,  FX),
    micro("6A",  p("M6A", "Micro AUD/USD",               "CME",   "0.0001",    "10000",    193,    FX)),
    micro("6B",  p("M6B", "Micro GBP/USD",               "CME",   "0.0001",    "6250",     187,    FX)),
    micro("6E",  p("M6E", "Micro EUR/USD",               "CME",   "0.0001",    "12500",    231,    FX)),
    micro("6C",  p("MCD", "Micro CAD/USD",               "CME",   "0.0001",    "10000",    99,     GLOBEX)),
    micro("6S",  p("MSF", "Micro CHF/USD",               "CME",   "0.0001",    "12500",    440,    GLOBEX)),
    micro("BTC", p("MBT", "Micro Bitcoin",               "CME",   "5",         "0.1",      2_001,  GLOBEX)),
                 p("ZB",  "U.S. Treasury Bond",          "CBOT",  "0.03125",   "1000",     4_070,  RATES),
                 p("ZN",  "10-Year T-Note",              "CBOT",  "0.015625",  "1000",     2_063,  RATES),
                 p("ZF",  "5-Year T-Note",               "CBOT",  "0.0078125", "1000",     1_375,  RATES),
                 p("ZT",  "2-Year T-Note",               "CBOT",  "0.0078125", "2000",     1_320,  RATES),
                 p("TN",  "Ultra 10-Year T-Note",        "CBOT",  "0.015625",  "1000",     2_805,  RATES),
                 p("UB",  "Ultra U.S. Treasury Bond",    "CBOT",  "0.03125",   "1000",     5_665,  RATES),
                 p("ZC",  "Corn",                        "CBOT",  "0.25",      "50",       1_155,  GLOBEX),
                 p("XC",  "Mini Corn",                   "CBOT",  "0.125",     "10",       231,    GLOBEX),
                 p("ZW",  "Chicago SRW Wheat",           "CBOT",  "0.25",      "50",       2_255,  GLOBEX),
                 p("ZO",  "Oats",                        "CBOT",  "0.25",      "50",       1_375,  GLOBEX),
                 p("ZR",  "Rough Rice",                  "CBOT",  "0.005",     "2000",     1_375,  GLOBEX),
                 p("ZS",  "Soybeans",                    "CBOT",  "0.25",      "50",       2_530,  GLOBEX),
                 p("ZL",  "Soybean Oil",                 "CBOT",  "0.01",      "600",      2_255,  GLOBEX),
                 p("ZM",  "Soybean Meal",                "CBOT",  "0.1",       "100",      1_650,  GLOBEX),
                 p("LE",  "Live Cattle",                 "CME",   "0.025",     "400",      3_300,  GLOBEX),
                 p("GF",  "Feeder Cattle",               "CME",   "0.025",     "500",      5_940,  GLOBEX),
                 p("HE",  "Lean Hogs",                   "CME",   "0.025",     "400",      1_650,  GLOBEX),
];

pub fn product(root: &str) -> Option<&'static Product> {
    let root = root.trim();
    PRODUCTS.iter().find(|p| p.root.eq_ignore_ascii_case(root))
}

#[cfg(test)]
mod tests {
    use std::collections::BTreeSet;

    use rust_decimal::Decimal;

    use super::*;

    #[test]
    fn every_product_is_listed_once_with_a_name_a_positive_tick_point_value_and_margin() {
        let roots: BTreeSet<&str> = PRODUCTS.iter().map(|p| p.root).collect();
        assert_eq!(roots.len(), PRODUCTS.len());
        for p in PRODUCTS {
            assert!(!p.name.is_empty(), "{}", p.root);
            for field in [p.tick, p.point_value] {
                let value = Decimal::from_str_exact(field).unwrap();
                assert!(value > Decimal::ZERO, "{}: {field}", p.root);
            }
            assert!(p.initial_margin_usd > 0, "{}", p.root);
            assert!(
                ["CME", "CBOT", "NYMEX", "COMEX"].contains(&p.exchange),
                "{}: {}",
                p.root,
                p.exchange
            );
        }
    }

    #[test]
    fn roots_match_whatever_their_case_and_spaces() {
        assert_eq!(product("mhg").map(|p| p.exchange), Some("COMEX"));
        assert_eq!(product(" nq ").map(|p| p.root), Some("NQ"));
        assert_eq!(product("QM").map(|p| p.point_value), Some("500"));
        assert_eq!(product("PLTR"), None);
    }

    #[test]
    fn each_root_trades_on_its_calendar_and_names_its_micro() {
        use SessionCalendar::*;
        let expected: [(&str, SessionCalendar, Option<&str>); 54] = [
            ("ES", CmeEquityIndex, Some("MES")),
            ("NQ", CmeEquityIndex, Some("MNQ")),
            ("YM", CmeEquityIndex, Some("MYM")),
            ("RTY", CmeEquityIndex, Some("M2K")),
            ("MES", CmeEquityIndex, None),
            ("MNQ", CmeEquityIndex, None),
            ("MYM", CmeEquityIndex, None),
            ("M2K", CmeEquityIndex, None),
            ("NKD", CmeGlobex, None),
            ("CL", CmeEnergy, Some("MCL")),
            ("MCL", CmeEnergy, None),
            ("QM", CmeEnergy, None),
            ("NG", CmeEnergy, Some("MNG")),
            ("MNG", CmeGlobex, None),
            ("HO", CmeEnergy, None),
            ("RB", CmeEnergy, None),
            ("GC", CmeGold, Some("MGC")),
            ("MGC", CmeGold, None),
            ("SI", CmeSilver, Some("SIL")),
            ("SIL", CmeSilver, None),
            ("HG", CmeCopper, Some("MHG")),
            ("MHG", CmeCopper, None),
            ("PL", CmePlatinum, None),
            ("6A", CmeFx, Some("M6A")),
            ("6B", CmeFx, Some("M6B")),
            ("6C", CmeFx, Some("MCD")),
            ("6E", CmeFx, Some("M6E")),
            ("6J", CmeFx, None),
            ("6M", CmeGlobex, None),
            ("6N", CmeGlobex, None),
            ("6S", CmeFx, Some("MSF")),
            ("M6A", CmeFx, None),
            ("M6B", CmeFx, None),
            ("M6E", CmeFx, None),
            ("MCD", CmeGlobex, None),
            ("MSF", CmeGlobex, None),
            ("MBT", CmeGlobex, None),
            ("ZB", CmeInterestRates, None),
            ("ZN", CmeInterestRates, None),
            ("ZF", CmeInterestRates, None),
            ("ZT", CmeInterestRates, None),
            ("TN", CmeInterestRates, None),
            ("UB", CmeInterestRates, None),
            ("ZC", CmeGlobex, None),
            ("XC", CmeGlobex, None),
            ("ZW", CmeGlobex, None),
            ("ZO", CmeGlobex, None),
            ("ZR", CmeGlobex, None),
            ("ZS", CmeGlobex, None),
            ("ZL", CmeGlobex, None),
            ("ZM", CmeGlobex, None),
            ("LE", CmeGlobex, None),
            ("GF", CmeGlobex, None),
            ("HE", CmeGlobex, None),
        ];
        for (root, calendar, micro) in expected {
            let p = product(root).unwrap();
            assert_eq!(p.calendar, calendar, "{root}");
            assert_eq!(SessionCalendar::of_cme_root(root), calendar, "{root}");
            assert_eq!(p.micro().map(|m| m.root), micro, "{root}");
            if let Some(m) = micro {
                assert_eq!(product(m).and_then(|m| m.micro_of), Some(root), "{m}");
            }
        }
        assert_eq!(expected.len(), PRODUCTS.len());
        assert_eq!(SessionCalendar::of_cme_root("XYZ"), CmeGlobex);
    }
}
