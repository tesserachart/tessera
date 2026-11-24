use chrono::NaiveDate;
use chrono::NaiveTime;
use rust_decimal::Decimal;
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use ts_rs::TS;

use crate::ids::{
    AccountGroupId, AccountId, BrokerId, ConnectionId, FundingProviderId, ProgramId, RuleSetId,
};
use crate::money::{Currency, Money, Qty, decimal_number};
use crate::time::{ExchangeTz, Timestamp};

/// Trading environment. Drives every safety cue.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum Environment {
    /// Tessera's own paper broker.
    Paper,
    /// A broker-hosted simulation or test system (Rithmic Test, Rithmic Paper Trading).
    Sim,
    /// A prop-firm evaluation account.
    Eval,
    /// A funded prop account.
    Funded,
    /// A live brokerage account.
    Live,
}

impl Environment {
    pub fn label(self) -> &'static str {
        match self {
            Environment::Paper => "PAPER",
            Environment::Sim => "SIM",
            Environment::Eval => "EVAL",
            Environment::Funded => "FUNDED",
            Environment::Live => "LIVE",
        }
    }

    pub fn is_simulated(self) -> bool {
        matches!(self, Environment::Paper | Environment::Sim)
    }

    pub fn allows_one_click(self) -> bool {
        matches!(self, Environment::Paper)
    }

    pub fn allows_direct_send(self, armed: bool, hold_confirmed: bool) -> bool {
        match self {
            Environment::Paper => armed || hold_confirmed,
            Environment::Sim | Environment::Eval | Environment::Funded | Environment::Live => {
                hold_confirmed
            }
        }
    }

    pub fn requires_hold_to_approve(self) -> bool {
        matches!(
            self,
            Environment::Eval | Environment::Funded | Environment::Live
        )
    }
}

/// What kind of external system a connection talks to.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum ConnectionKind {
    /// Tessera's built-in paper broker.
    Paper,
    /// Rithmic R|Protocol.
    Rithmic,
    Tradovate,
    /// Coinbase public market data.
    Coinbase,
    /// MenthorQ intelligence (interface only).
    Menthorq,
}

/// A reference to a secret in the secret store. The secret itself never appears in Tessera's
/// data model, logs or protocol.
#[derive(Clone, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct CredentialRef {
    /// Store holding the secret.
    pub store: CredentialStore,
    /// Key within the store (e.g. `tessera/rithmic/prop-01`).
    pub key: String,
}

/// Where a secret lives.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum CredentialStore {
    /// The OS keyring (Secret Service on Linux).
    Keyring,
    /// Development fallback: `~/.config/tessera/credentials.env` (mode 600).
    DevFile,
}

/// A configured connection to an external system.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ConnectionProvider {
    /// Id.
    pub id: ConnectionId,
    /// System kind.
    pub kind: ConnectionKind,
    /// Display name (`Rithmic Test`).
    pub display_name: String,
    /// System name as reported by the vendor (`Rithmic Test`, `Rithmic Paper Trading`, `Apex`).
    pub system_name: Option<String>,
    /// Credential reference, if the connection needs one.
    pub credential: Option<CredentialRef>,
    /// Whether the user enabled it.
    pub enabled: bool,
}

/// A broker or futures commission merchant.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct Broker {
    /// Id.
    pub id: BrokerId,
    /// Display name (`Tessera Paper`).
    pub name: String,
    /// Clearing FCM, if known.
    pub fcm: Option<String>,
}

/// A prop firm or other funding provider.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct FundingProvider {
    /// Id.
    pub id: FundingProviderId,
    /// Display name.
    pub name: String,
    /// Website, for provenance of imported rules.
    pub website: Option<String>,
}

/// A funding program (plan), e.g. a 50K evaluation.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct Program {
    /// Id.
    pub id: ProgramId,
    /// Funding provider.
    pub provider_id: FundingProviderId,
    /// Name (`50K`).
    pub name: String,
    /// Starting balance.
    pub starting_balance: Money,
}

/// How a rule's status can be computed from the data Tessera has.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum Computability {
    /// Exactly, from fills and contract specs.
    Exact,
    /// Approximately (e.g. intraday trailing from bars).
    Approximate,
    /// Needs live marks to be exact.
    NeedsLive,
    /// Informational only.
    InfoOnly,
}

/// What locks a trailing drawdown.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "snake_case", tag = "kind")]
pub enum LockTrigger {
    /// Locks once the balance reaches starting balance plus this amount.
    BalanceReaches {
        /// Threshold above starting balance.
        #[serde(with = "decimal_number")]
        #[ts(type = "number")]
        #[schemars(with = "f64")]
        above_start: Decimal,
    },
    /// Locks at the first payout.
    FirstPayout,
}

/// A typed, versionable risk rule.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "snake_case", tag = "kind")]
pub enum RiskRule {
    /// Maximum loss in one session (CME session date for futures).
    DailyLossLimit {
        /// Limit.
        amount: Money,
    },
    /// Trailing drawdown from the high-water mark.
    #[serde(rename_all = "camelCase")]
    TrailingDrawdown {
        /// Distance from the high-water mark.
        amount: Money,
        /// Whether the high-water mark updates intraday (needs live marks) or end of day.
        intraday: bool,
        /// What stops the trail, if anything.
        lock: Option<LockTrigger>,
    },
    /// Maximum contracts or shares held per root or instrument.
    MaxPosition {
        /// Root (`NQ`) or instrument id (`QQQ`).
        scope: String,
        /// Limit.
        qty: Qty,
    },
    /// Maximum size of a single order.
    MaxOrderSize {
        /// Root or instrument id, or `*` for all.
        scope: String,
        /// Limit.
        qty: Qty,
    },
    /// Orders allowed only inside this window.
    TradingWindow {
        /// Window start (local).
        #[ts(type = "string")]
        start: NaiveTime,
        /// Window end (local).
        #[ts(type = "string")]
        end: NaiveTime,
        /// Zone the window is expressed in.
        tz: ExchangeTz,
    },
    /// Profit target to pass an evaluation.
    ProfitTarget {
        /// Target above starting balance.
        amount: Money,
    },
    /// No single day may exceed this share of total profit.
    #[serde(rename_all = "camelCase")]
    Consistency {
        /// Maximum share of total profit from the best day, 0–1.
        #[serde(with = "decimal_number")]
        #[ts(type = "number")]
        #[schemars(with = "f64")]
        max_best_day_share: Decimal,
    },
}

/// A versioned set of rules for a program. Firm presets are imported **unverified**.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct RuleSet {
    /// Id.
    pub id: RuleSetId,
    /// Program.
    pub program_id: ProgramId,
    /// Version (monotonic per program).
    pub version: u32,
    /// Applies to accounts purchased on or after this date.
    #[ts(type = "string")]
    pub effective_from: NaiveDate,
    /// True once checked against the firm's current terms.
    pub verified: bool,
    /// Where the rules came from (URL, document, import).
    pub source: String,
    /// The rules.
    pub rules: Vec<RiskRule>,
}

/// Account-level restrictions.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct Restrictions {
    /// Copying trades across accounts is banned by the firm.
    pub no_copy_trading: bool,
    /// Instruments or roots that may not be traded.
    pub blocked_instruments: Vec<String>,
    /// Loosening a rule takes effect next session only.
    pub loosen_next_session: bool,
}

/// How and when payouts happen (data model only in the MVP).
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct PayoutPolicy {
    /// Minimum qualifying days before a payout.
    pub min_qualifying_days: u32,
    /// Minimum profit for a day to qualify.
    pub qualifying_day_min_profit: Option<Money>,
    /// Trader's profit split, 0–1.
    #[serde(with = "decimal_number")]
    #[ts(type = "number")]
    #[schemars(with = "f64")]
    pub profit_split: Decimal,
}

/// The account orders are sent to.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct TradingAccount {
    /// Id (`paper-main`).
    pub id: AccountId,
    /// Display name.
    pub display_name: String,
    /// Environment; drives safety cues and the send-path guard.
    pub environment: Environment,
    /// Broker.
    pub broker_id: BrokerId,
    /// Connection used to reach it.
    pub connection_id: ConnectionId,
    /// Funding program, for prop accounts.
    pub program_id: Option<ProgramId>,
    /// Rule set version in force.
    pub rule_set_id: Option<RuleSetId>,
    /// Account currency.
    pub currency: Currency,
    /// Restrictions.
    pub restrictions: Restrictions,
    /// Group membership.
    pub group_id: Option<AccountGroupId>,
    /// Broker-side account number, masked for display (`••••4821`). Never the full number.
    pub external_ref_masked: Option<String>,
}

/// A group of accounts traded together (data model + paper simulation only in the MVP).
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct AccountGroup {
    /// Id.
    pub id: AccountGroupId,
    /// Name.
    pub name: String,
    /// Member accounts.
    pub members: Vec<AccountId>,
}

/// Balance summary of one account.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct AccountSummary {
    /// Account.
    pub account_id: AccountId,
    /// Cash balance: starting balance plus realized P&L, less fees (open P&L excluded).
    pub balance: Money,
    /// Net liquidation value: balance plus open P&L.
    pub net_liq: Money,
    /// Today's P&L (realized + unrealized change today).
    pub day_pnl: Money,
    /// Realized today (gross of fees).
    pub realized_today: Money,
    /// Fees and commissions charged today.
    pub fees_today: Money,
    /// Unrealized change today.
    pub unrealized_today: Money,
    /// Open P&L of all positions since entry.
    pub open_pnl: Money,
    /// Buying power.
    pub buying_power: Money,
    /// As of.
    pub as_of: Timestamp,
}

/// Which prop rule a breach or a pre-trade refusal concerns.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum RuleKind {
    DailyLossLimit,
    /// The trailing drawdown threshold.
    TrailingDrawdown,
}

/// A breach of a prop rule: the account was flattened, its orders cancelled and it is locked.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct RuleBreach {
    /// The rule.
    pub rule: RuleKind,
    /// When it was breached.
    pub at: Timestamp,
    /// Net liquidation value at the breach.
    pub net_liq: Money,
    /// What happened, in the trader's words (`Daily limit reached. Locked until 18:00.`).
    pub message: String,
}

/// Where an account stands against its prop rules (evaluation and funded accounts). Every amount is
/// computed from the account's own fills and marks.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct RiskStatus {
    /// Account.
    pub account_id: AccountId,
    /// Daily loss limit, measured from the day's starting net liquidation value.
    pub daily_loss_limit: Option<Money>,
    /// What can still be lost today before the limit binds (`$690 left today`); never negative.
    pub daily_loss_remaining: Option<Money>,
    /// The firm's drawdown threshold (trailing, static or end of day, as the firm sets it): the net
    /// liquidation value that must never be reached.
    pub trailing_threshold: Option<Money>,
    /// Net liquidation value above the threshold (`$3,040 above the firm's drawdown`); never negative.
    pub trailing_room: Option<Money>,
    /// High-water mark of the net liquidation value the threshold trails.
    pub high_water_mark: Option<Money>,
    /// The smaller of the two rooms: what one more loss may cost before a rule binds.
    pub room: Option<Money>,
    /// The account takes no new entries (exits still work).
    pub locked: bool,
    /// Until when (the next session's open).
    pub locked_until: Option<Timestamp>,
    /// The breach that locked it.
    pub breach: Option<RuleBreach>,
    /// The broker's own account-wide contract limits, as its risk system reports them. The
    /// broker applies them itself, and may count a micro as a fraction of a mini.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub contract_limits: Option<ContractLimits>,
    /// As of.
    pub as_of: Timestamp,
}

/// A broker's account-wide contract limits, as its risk system reports them (Rithmic's RMS).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ContractLimits {
    /// Contracts it allows held long.
    pub buy: Option<u32>,
    /// Contracts it allows held short.
    pub sell: Option<u32>,
    /// Contracts it allows in one order.
    pub per_order: Option<u32>,
}

pub fn mask_account_number(raw: &str) -> String {
    let chars: Vec<char> = raw.chars().filter(|c| !c.is_whitespace()).collect();
    let keep = chars.len().min(4);
    let tail: String = chars[chars.len() - keep..].iter().collect();
    format!("••••{tail}")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn environment_safety_cues() {
        use Environment::*;
        for e in [Paper, Sim, Eval, Funded, Live] {
            assert_eq!(e.is_simulated(), matches!(e, Paper | Sim));
            assert_eq!(e.allows_one_click(), e == Paper);
            assert!(
                !e.allows_direct_send(false, false),
                "{e:?}: nothing without arm or hold"
            );
            assert_eq!(
                e.allows_direct_send(true, false),
                e == Paper,
                "{e:?}: a click"
            );
            assert!(e.allows_direct_send(false, true), "{e:?}: a hold");
            assert_eq!(
                e.requires_hold_to_approve(),
                matches!(e, Eval | Funded | Live)
            );
        }
        assert_eq!(serde_json::to_string(&Paper).unwrap(), "\"paper\"");
        assert_eq!(Live.label(), "LIVE");
    }

    #[test]
    fn masking_never_leaks_more_than_four() {
        assert_eq!(mask_account_number("SAMPLE-00004821"), "••••4821");
        assert_eq!(mask_account_number("12"), "••••12");
    }

    #[test]
    fn rules_serialize_tagged() {
        let r = RiskRule::TrailingDrawdown {
            amount: Money::usd(Decimal::from(2000)),
            intraday: true,
            lock: Some(LockTrigger::FirstPayout),
        };
        let v = serde_json::to_value(&r).unwrap();
        assert_eq!(v["kind"], "trailing_drawdown");
        assert_eq!(v["lock"]["kind"], "first_payout");
        let back: RiskRule = serde_json::from_value(v).unwrap();
        assert_eq!(back, r);
    }
}
