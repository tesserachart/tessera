use rust_decimal::Decimal;

use crate::money::Money;
use crate::products::product;

pub fn initial_margin(root: &str) -> Option<Money> {
    product(root.trim()).map(|p| Money::usd(Decimal::from(p.initial_margin_usd)))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn known_futures_carry_their_cme_initial_margin_and_unknown_roots_none() {
        let usd = |root: &str| initial_margin(root).map(|m| m.amount);
        assert_eq!(usd("NQ"), Some(Decimal::from(45_532)));
        assert_eq!(usd("MNQ"), Some(Decimal::from(4_553)));
        assert_eq!(usd("ES"), Some(Decimal::from(25_777)));
        assert_eq!(usd("MES"), Some(Decimal::from(2_577)));
        assert_eq!(usd("CL"), Some(Decimal::from(10_117)));
        assert_eq!(usd("GC"), Some(Decimal::from(22_864)));
        assert_eq!(usd("RTY"), Some(Decimal::from(11_239)));
        assert_eq!(usd("ZN"), Some(Decimal::from(2_063)));
        assert_eq!(usd(" mnq "), Some(Decimal::from(4_553)));
        assert_eq!(usd("XYZ"), None);
        assert_eq!(usd("QQQ"), None);
    }
}
