use chrono::NaiveDate;
use rust_decimal::Decimal;
use serde::{Deserialize, Serialize};
use tessera_core::accounts::{AccountSummary, Environment, Restrictions, TradingAccount};
use tessera_core::ids::{AccountId, BrokerId, ConnectionId};
use tessera_core::money::{Currency, Money};
use tessera_core::session::SessionCalendar;
use tessera_core::{InstrumentId, Timestamp};

pub const DAY_CALENDAR: SessionCalendar = SessionCalendar::CmeGlobex;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AccountSeed {
    pub id: &'static str,
    pub name: &'static str,
    pub environment: Environment,
    pub balance: Decimal,
    pub formerly: Option<(&'static str, &'static str)>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PaperAccount {
    pub account: TradingAccount,
    pub starting_balance: Money,
    pub balance: Money,
    #[serde(with = "date")]
    pub day: NaiveDate,
    pub day_start_net_liq: Money,
    #[serde(default)]
    pub awaiting_day_mark: Vec<InstrumentId>,
    pub realized_today: Money,
    pub fees_today: Money,
}

mod date {
    use chrono::NaiveDate;
    use serde::{Deserialize, Deserializer, Serializer};

    pub fn serialize<S: Serializer>(d: &NaiveDate, s: S) -> Result<S::Ok, S::Error> {
        s.serialize_str(&d.format("%Y-%m-%d").to_string())
    }

    pub fn deserialize<'de, D: Deserializer<'de>>(d: D) -> Result<NaiveDate, D::Error> {
        let s = String::deserialize(d)?;
        NaiveDate::parse_from_str(&s, "%Y-%m-%d").map_err(serde::de::Error::custom)
    }
}

pub fn default_seeds() -> Vec<AccountSeed> {
    vec![AccountSeed {
        id: "paper-main",
        name: "Paper",
        environment: Environment::Paper,
        balance: Decimal::from(100_000),
        formerly: Some(("paper-main", "paper-main")),
    }]
}

#[cfg(any(test, feature = "test-support"))]
pub fn test_seeds() -> Vec<AccountSeed> {
    let mut seeds = default_seeds();
    seeds.push(AccountSeed {
        id: "eval-50k",
        name: "Eval 50K",
        environment: Environment::Eval,
        balance: Decimal::from(51_240),
        formerly: None,
    });
    seeds
}

impl PaperAccount {
    pub fn open(seed: &AccountSeed, connection: &str, now: Timestamp) -> Self {
        let balance = Money::usd(seed.balance);
        Self {
            account: TradingAccount {
                id: AccountId::new(seed.id),
                display_name: seed.name.to_owned(),
                environment: seed.environment,
                broker_id: BrokerId::new("tessera-paper"),
                connection_id: ConnectionId::new(connection),
                program_id: None,
                rule_set_id: None,
                currency: Currency::Usd,
                restrictions: Restrictions::default(),
                group_id: None,
                external_ref_masked: None,
            },
            starting_balance: balance,
            balance,
            day: DAY_CALENDAR.trade_date(now),
            day_start_net_liq: balance,
            awaiting_day_mark: Vec::new(),
            realized_today: Money::zero(Currency::Usd),
            fees_today: Money::zero(Currency::Usd),
        }
    }

    pub fn id(&self) -> &AccountId {
        &self.account.id
    }

    pub fn name(&self) -> &str {
        &self.account.display_name
    }

    pub fn rolls_at(&self, now: Timestamp) -> bool {
        DAY_CALENDAR.trade_date(now) != self.day
    }

    pub fn roll(
        &mut self,
        now: Timestamp,
        net_liq: Money,
        awaiting_day_mark: Vec<InstrumentId>,
    ) -> bool {
        if !self.rolls_at(now) {
            return false;
        }
        self.day = DAY_CALENDAR.trade_date(now);
        self.day_start_net_liq = net_liq;
        self.awaiting_day_mark = awaiting_day_mark;
        self.realized_today = Money::zero(self.balance.currency);
        self.fees_today = Money::zero(self.balance.currency);
        true
    }

    pub fn mark_day_start(&mut self, instrument: &InstrumentId, open_pnl: Decimal) -> bool {
        let Some(at) = self.awaiting_day_mark.iter().position(|i| i == instrument) else {
            return false;
        };
        self.awaiting_day_mark.remove(at);
        self.day_start_net_liq.amount += open_pnl;
        true
    }

    pub fn book(&mut self, realized: Decimal, fee: Decimal) {
        self.balance.amount += realized - fee;
        self.realized_today.amount += realized;
        self.fees_today.amount += fee;
    }

    pub fn summary(
        &self,
        net_liq: Money,
        open_pnl: Money,
        unmarked_open_pnl: Decimal,
        buying_power: Money,
        now: Timestamp,
    ) -> AccountSummary {
        let currency = self.balance.currency;
        let day_pnl = net_liq.amount - unmarked_open_pnl - self.day_start_net_liq.amount;
        let unrealized_today = day_pnl - self.realized_today.amount + self.fees_today.amount;
        AccountSummary {
            account_id: self.account.id.clone(),
            balance: self.balance,
            net_liq,
            day_pnl: Money::new(day_pnl, currency),
            realized_today: self.realized_today,
            fees_today: self.fees_today,
            unrealized_today: Money::new(unrealized_today, currency),
            open_pnl,
            buying_power,
            as_of: now,
        }
    }
}

pub fn clock_label(at: Timestamp, now: Timestamp) -> String {
    clock_label_in(at, now, DAY_CALENDAR.tz())
}

pub fn clock_label_in(at: Timestamp, now: Timestamp, tz: chrono_tz::Tz) -> String {
    let local = at.in_tz(tz);
    if at.0 - now.0 < 24 * 3600 * 1_000_000_000 {
        local.format("%H:%M").to_string()
    } else {
        local.format("%a %H:%M").to_string()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn usd(v: i64) -> Money {
        Money::usd(Decimal::from(v))
    }

    #[test]
    fn the_accounts_start_at_their_seeds_balance_and_carry_no_rules() {
        let now = Timestamp::parse("2026-10-02T14:42:30-04:00").unwrap();
        assert_eq!(default_seeds().len(), 1);
        let main = PaperAccount::open(&default_seeds()[0], "paper", now);
        assert_eq!(main.name(), "Paper");
        assert_eq!(main.account.environment, Environment::Paper);
        assert_eq!(main.balance, usd(100_000));
        let eval = PaperAccount::open(&test_seeds()[1], "paper", now);
        assert_eq!(eval.name(), "Eval 50K");
        assert_eq!(eval.account.environment, Environment::Eval);
        assert_eq!(eval.balance, usd(51_240));
    }

    #[test]
    fn an_account_stored_with_simulated_prop_rules_loads_without_them() {
        let now = Timestamp::parse("2026-10-02T14:42:30-04:00").unwrap();
        let mut stored =
            serde_json::to_value(PaperAccount::open(&test_seeds()[1], "paper", now)).unwrap();
        let o = stored.as_object_mut().unwrap();
        o.insert(
            "rules".into(),
            serde_json::json!({"dailyLossLimit": {"amount": 1000, "currency": "USD"}}),
        );
        o.insert(
            "threshold".into(),
            serde_json::json!({"amount": 48200, "currency": "USD"}),
        );
        o.insert("lockedUntil".into(), serde_json::json!(1));
        let a: PaperAccount = serde_json::from_value(stored).unwrap();
        assert_eq!(a.balance, usd(51_240));
        let back = serde_json::to_value(&a).unwrap();
        assert!(back.get("rules").is_none() && back.get("threshold").is_none());
    }

    #[test]
    fn the_day_rolls_at_the_session_change() {
        let fri = Timestamp::parse("2026-10-02T14:42:30-04:00").unwrap();
        let mut a = PaperAccount::open(&test_seeds()[1], "paper", fri);
        a.book(Decimal::from(-310), Decimal::ZERO);
        assert!(!a.roll(fri, usd(50_930), Vec::new()));
        let sunday = Timestamp::parse("2026-10-04T18:00:00-04:00").unwrap();
        assert!(a.roll(sunday, usd(50_930), Vec::new()));
        assert_eq!(a.day_start_net_liq, usd(50_930));
        assert_eq!(a.realized_today, usd(0));
    }
}
