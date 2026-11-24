use std::collections::BTreeSet;

use tessera_core::accounts::Environment;
use tessera_core::ids::AccountId;

use crate::BrokerSystem;

const DEFAULT_ALLOWED_SYSTEMS: [&str; 3] =
    ["Tessera Paper", "Rithmic Paper Trading", "Rithmic Test"];

const DEFAULT_SIMULATORS: [&str; 1] = ["Tessera Paper"];

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum SendRefused {
    #[error("order routing is not enabled for this connection")]
    RoutingDisabled,
    #[error("order entry is off for this account; turn it on in Accounts")]
    OrderEntryOff,
    #[error("this connection is read-only")]
    ReadOnly,
    #[error("account {0} is not on this connection")]
    UnknownAccount(AccountId),
    #[error("the order does not match its account: {0}")]
    Mismatch(String),
}

#[derive(Debug, Clone)]
pub(crate) struct SendPathGuard {
    allowed: BTreeSet<String>,
    simulators: BTreeSet<String>,
}

impl Default for SendPathGuard {
    fn default() -> Self {
        Self::new(DEFAULT_ALLOWED_SYSTEMS)
    }
}

impl SendPathGuard {
    fn new<I, S>(allowed: I) -> Self
    where
        I: IntoIterator<Item = S>,
        S: Into<String>,
    {
        let allowed: BTreeSet<String> = allowed.into_iter().map(Into::into).collect();
        let simulators = DEFAULT_SIMULATORS
            .iter()
            .map(|s| (*s).to_owned())
            .filter(|s| allowed.contains(s))
            .collect();
        Self {
            allowed,
            simulators,
        }
    }

    pub fn is_simulator(&self, system: &BrokerSystem) -> bool {
        system.environment == Environment::Paper && self.simulators.contains(&system.name)
    }

    pub fn is_paper_routed(&self, system: &BrokerSystem, account_env: Environment) -> bool {
        if self.is_simulator(system) {
            return true;
        }
        account_env.is_simulated()
            && system.environment.is_simulated()
            && self.allowed.contains(&system.name)
    }

    pub fn check(
        &self,
        system: &BrokerSystem,
        account_env: Environment,
        read_only: bool,
        account_order_entry: bool,
    ) -> Result<(), SendRefused> {
        if !self.is_paper_routed(system, account_env) && !account_order_entry {
            return Err(SendRefused::OrderEntryOff);
        }
        if read_only {
            return Err(SendRefused::ReadOnly);
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const ENVS: [Environment; 5] = [
        Environment::Paper,
        Environment::Sim,
        Environment::Eval,
        Environment::Funded,
        Environment::Live,
    ];

    #[test]
    fn guard_matrix() {
        let g = SendPathGuard::default();
        let systems = [
            "Tessera Paper",
            "Rithmic Paper Trading",
            "Rithmic Test",
            "Apex",
            "Bulenox",
            "Rithmic 01",
            "Rithmic 04 Colo",
            "rithmic test",
            "apex",
        ];
        for name in systems {
            for sys_env in ENVS {
                for acct_env in ENVS {
                    for read_only in [false, true] {
                        for entry in [false, true] {
                            let sys = BrokerSystem {
                                name: name.into(),
                                environment: sys_env,
                            };
                            let r = g.check(&sys, acct_env, read_only, entry);
                            let simulator =
                                name == "Tessera Paper" && sys_env == Environment::Paper;
                            let paper = simulator
                                || (DEFAULT_ALLOWED_SYSTEMS.contains(&name)
                                    && sys_env.is_simulated()
                                    && acct_env.is_simulated());
                            let allowed = (paper || entry) && !read_only;
                            assert_eq!(
                                r.is_ok(),
                                allowed,
                                "{name} {sys_env:?} {acct_env:?} ro={read_only} entry={entry}: {r:?}"
                            );
                        }
                    }
                }
            }
        }
    }

    #[test]
    fn funded_and_live_accounts_send_like_an_evaluation() {
        let g = SendPathGuard::default();
        let apex = BrokerSystem {
            name: "Apex".into(),
            environment: Environment::Eval,
        };
        let live = BrokerSystem {
            name: "Rithmic 01".into(),
            environment: Environment::Live,
        };
        for (system, env) in [
            (&apex, Environment::Eval),
            (&apex, Environment::Funded),
            (&live, Environment::Live),
            (&live, Environment::Eval),
        ] {
            assert_eq!(
                g.check(system, env, false, false),
                Err(SendRefused::OrderEntryOff),
                "{env:?}: off by default"
            );
            assert!(g.check(system, env, false, true).is_ok(), "{env:?}");
            assert_eq!(
                g.check(system, env, true, true),
                Err(SendRefused::ReadOnly),
                "{env:?}: a read-only connection stays read-only"
            );
        }
    }

    #[test]
    fn refusal_reasons() {
        let g = SendPathGuard::default();
        let apex = BrokerSystem {
            name: "Apex".into(),
            environment: Environment::Sim,
        };
        assert_eq!(
            g.check(&apex, Environment::Sim, false, false),
            Err(SendRefused::OrderEntryOff)
        );
        let rithmic_paper = BrokerSystem {
            name: "Rithmic Paper Trading".into(),
            environment: Environment::Sim,
        };
        assert_eq!(
            g.check(&rithmic_paper, Environment::Eval, false, false),
            Err(SendRefused::OrderEntryOff)
        );
        let simulator = BrokerSystem {
            name: "Tessera Paper".into(),
            environment: Environment::Paper,
        };
        for env in ENVS {
            assert!(g.check(&simulator, env, false, false).is_ok(), "{env:?}");
        }
        let test = BrokerSystem {
            name: "Rithmic Test".into(),
            environment: Environment::Sim,
        };
        assert!(g.check(&test, Environment::Sim, false, false).is_ok());
    }
}
