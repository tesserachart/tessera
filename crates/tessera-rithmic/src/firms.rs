use tessera_core::accounts::Environment;

use crate::templates::PAPER_SYSTEMS;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Firm {
    pub system: &'static str,
    pub funded_words: &'static [&'static str],
}

const fn firm(system: &'static str, funded_words: &'static [&'static str]) -> Firm {
    Firm {
        system,
        funded_words,
    }
}

/// Prop firms' systems, named exactly as Rithmic's system list spells them, each with the words
/// the firm writes in a funded account's id or name. Each system runs the firm's simulated
/// evaluation accounts, and at some firms its funded ones.
pub const FIRMS: &[Firm] = &[
    firm("4PropTrader", &["FUNDED"]),
    firm("Apex", &["PA"]),
    firm("BluSky", &["FUNDED"]),
    firm("Bulenox", &["MASTER", "FUNDED"]),
    firm("DayTraders.com", &["FUNDED"]),
    firm("Earn2Trade", &["FUNDED"]),
    firm("FundedFuturesNetwork", &["FUNDED"]),
    firm("GoatFundedFutures", &["FUNDED"]),
    firm("HOLAPRIME", &["FUNDED"]),
    firm("LucidTrading", &["FUNDED"]),
    firm("PropShopTrader", &["FUNDED"]),
    firm("TheTradingPit", &["FUNDED"]),
    firm("TopstepTrader", &["XFA", "EXPRESS", "FUNDED"]),
    firm("TradeFundrr", &["FUNDED"]),
    firm("Tradeify", &["FUNDED"]),
];

pub fn firm_of(system: &str) -> Option<&'static Firm> {
    FIRMS.iter().find(|f| f.system == system)
}

pub fn system_environment(system: &str) -> Environment {
    if PAPER_SYSTEMS.contains(&system) {
        Environment::Sim
    } else if firm_of(system).is_some() {
        Environment::Eval
    } else {
        Environment::Live
    }
}

fn words(text: &str) -> impl Iterator<Item = String> + '_ {
    text.split(|c: char| !c.is_ascii_alphanumeric())
        .filter(|w| !w.is_empty())
        .map(str::to_ascii_uppercase)
}

impl Firm {
    pub fn is_funded(&self, account_id: &str, account_name: Option<&str>) -> bool {
        words(account_id)
            .chain(account_name.into_iter().flat_map(words))
            .any(|w| self.funded_words.contains(&w.as_str()))
    }
}

pub fn environment(system: &str, account_id: &str, account_name: Option<&str>) -> Environment {
    match firm_of(system) {
        Some(f) if f.is_funded(account_id, account_name) => Environment::Funded,
        _ => system_environment(system),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_firm_reads_its_own_funded_words() {
        let env = |system, id| environment(system, id, None);
        assert_eq!(env("Apex", "APEX-123-01"), Environment::Eval);
        assert_eq!(env("Apex", "PA-APEX-123-01"), Environment::Funded);
        assert_eq!(
            env("TopstepTrader", "50KTC-V2-12345-678"),
            Environment::Eval
        );
        assert_eq!(env("TopstepTrader", "150KTC-12345"), Environment::Eval);
        assert_eq!(env("TopstepTrader", "XFA-12345-678"), Environment::Funded);
        assert_eq!(
            env("TopstepTrader", "EXPRESS-V2-12345"),
            Environment::Funded
        );
        assert_eq!(env("Bulenox", "BX000642-002"), Environment::Eval);
        assert_eq!(env("Bulenox", "BX000642-MASTER-1"), Environment::Funded);
        assert_eq!(
            environment("Bulenox", "BX000642-003", Some("Master 50K")),
            Environment::Funded
        );
        assert_eq!(env("Tradeify", "TDY-FUNDED-50K-1"), Environment::Funded);
        assert_eq!(env("Tradeify", "TDY-50K-1"), Environment::Eval);
    }

    #[test]
    fn a_funded_word_counts_only_as_a_whole_word_at_its_own_firm() {
        let env = |system, id| environment(system, id, None);
        assert_eq!(env("Apex", "PAPEX-123"), Environment::Eval);
        assert_eq!(env("Apex", "APEX-123-PAD"), Environment::Eval);
        assert_eq!(env("Bulenox", "PA-1"), Environment::Eval);
        assert_eq!(env("Apex", "XFA-1"), Environment::Eval);
        assert_eq!(env("Apex", "pa-apex-123-01"), Environment::Funded);
    }

    #[test]
    fn systems_that_are_no_firm_keep_their_own_kind() {
        let env = |system, id| environment(system, id, None);
        assert_eq!(env("Rithmic Paper Trading", "PA-1"), Environment::Sim);
        assert_eq!(env("Rithmic Test", "X"), Environment::Sim);
        assert_eq!(env("Rithmic 01", "PA-1"), Environment::Live);
        assert_eq!(env("apex", "PA-1"), Environment::Live);
        assert_eq!(env("Rithmic 04 Colo", "X"), Environment::Live);
        assert_eq!(env("Tradeify-Test", "X"), Environment::Live);
        for f in FIRMS {
            assert_eq!(
                system_environment(f.system),
                Environment::Eval,
                "{}",
                f.system
            );
            assert!(!f.funded_words.is_empty(), "{}", f.system);
        }
    }

    #[test]
    fn the_firm_list_holds_no_live_test_or_paper_system() {
        for f in FIRMS {
            let s = f.system;
            assert!(!PAPER_SYSTEMS.contains(&s));
            assert!(!s.starts_with("Rithmic"), "{s}");
            assert!(!s.to_ascii_lowercase().contains("test"), "{s}");
            assert!(!s.to_ascii_lowercase().starts_with("tradesea"), "{s}");
            assert_eq!(FIRMS.iter().filter(|g| g.system == s).count(), 1, "{s}");
        }
    }
}
