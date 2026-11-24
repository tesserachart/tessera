use std::process::ExitCode;
use std::sync::Arc;

use rust_decimal::Decimal;
use tessera_broker::paper::{AccountSeed, default_seeds};
use tessera_core::accounts::Environment;
use tessera_core::clock::ManualClock;
use tessera_core::{SharedClock, Timestamp};
use tessera_runtime::cli::{Launch, main as cli};
use tessera_runtime::secrets::Secrets;
use tessera_store::ticks::Span;
use tessera_testkit::crash::crash_module_from_env;
use tessera_testkit::firm::FirmLogin;
use tessera_testkit::{BUSY_AT, Fakes, ShiftedClock, frozen_clock};
use tessera_testkit::{levels, rithmic};

fn busy() -> bool {
    std::env::var("TESSERA_TEST_MARKET").is_ok_and(|v| v == "busy")
}

fn rithmic_serves_mock() -> bool {
    std::env::var("TESSERA_TEST_MARKET").is_ok_and(|v| v == "rithmic")
}

fn rithmic_after_login() -> rithmic::AfterLogin {
    if std::env::var("TESSERA_TEST_RITHMIC").is_ok_and(|v| v == "dropped") {
        rithmic::AfterLogin::DropsOnItsSecondTry
    } else {
        rithmic::AfterLogin::Stays
    }
}

fn trades_replayed() -> bool {
    std::env::var("TESSERA_TEST_TRADES").is_ok_and(|v| v == "replay")
}

fn replays_refused() -> bool {
    std::env::var("TESSERA_TEST_REPLAY").is_ok_and(|v| v == "refuse")
}

fn instant(text: &str, var: &str) -> Timestamp {
    Timestamp::parse(text.trim())
        .unwrap_or_else(|e| panic!("{var}: {text:?} is not an RFC 3339 instant: {e}"))
}

fn frozen_at() -> Option<Timestamp> {
    let var = "TESSERA_TEST_NOW";
    std::env::var(var).ok().map(|v| instant(&v, var))
}

fn stored() -> Vec<Span> {
    let var = "TESSERA_TEST_STORED";
    let Ok(spans) = std::env::var(var) else {
        return Vec::new();
    };
    spans
        .split(',')
        .filter(|s| !s.trim().is_empty())
        .map(|s| {
            let (from, to) = s
                .split_once('/')
                .unwrap_or_else(|| panic!("{var}: {s:?} is not <start>/<end>"));
            Span::new(instant(from, var).0, instant(to, var).0)
        })
        .collect()
}

fn live_levels() -> bool {
    std::env::var("TESSERA_TEST_LEVELS").is_ok_and(|v| v == "live")
}

fn millis(var: &str) -> Option<std::time::Duration> {
    std::env::var(var)
        .ok()
        .and_then(|v| v.parse().ok())
        .map(std::time::Duration::from_millis)
}

fn paper_accounts() -> Vec<AccountSeed> {
    let mut seeds = default_seeds();
    seeds.extend(
        [("paper-2", "Paper 2"), ("paper-3", "Paper 3")].map(|(id, name)| AccountSeed {
            id,
            name,
            environment: Environment::Paper,
            balance: Decimal::from(50_000),
            formerly: None,
        }),
    );
    seeds
}

fn accounts_on() -> bool {
    std::env::var("TESSERA_TEST_ACCOUNTS").is_ok_and(|v| v == "1")
}

fn main() -> ExitCode {
    let clock: SharedClock = if busy() {
        Arc::new(ShiftedClock::starting_at(
            Timestamp::parse(BUSY_AT).expect("BUSY_AT is RFC 3339"),
        ))
    } else {
        frozen_at().map_or_else(frozen_clock, |at| -> SharedClock {
            Arc::new(ManualClock::new(at))
        })
    };
    cli(Launch {
        modules: || {
            let fakes = if busy() {
                Fakes::busy()
            } else {
                Fakes::still(20)
            };
            let fakes = Fakes {
                mock_connected: !rithmic_serves_mock(),
                keeps_trade_history: !trades_replayed(),
                refuses_replays: replays_refused(),
                stored: stored(),
                market_after: millis("TESSERA_TEST_MARKET_AFTER_MS"),
                logs_in_after: millis("TESSERA_TEST_MARKET_LOGIN_MS"),
                ..fakes
            };
            let mut modules = vec![fakes.module()];
            if let Some(firm) = FirmLogin::from_env() {
                modules.push(firm.module());
            }
            if let Some(crash) = crash_module_from_env() {
                modules.push(crash);
            }
            modules
        },
        clock: Some(clock),
        credentials_files: false,
        accounts: accounts_on(),
        paper_accounts,
        secrets: Secrets::in_memory,
        rithmic: |clock| {
            rithmic::factory_with(
                clock,
                rithmic_serves_mock().then(|| rithmic::Serves {
                    replay_pause: millis("TESSERA_TEST_HISTORY_MS")
                        .unwrap_or(rithmic::REPLAY_PAUSE),
                    refuses_replays: replays_refused(),
                    ..rithmic::Serves::default()
                }),
                rithmic_after_login(),
            )
        },
        level_http: || {
            if live_levels() {
                None
            } else {
                levels::vendors()
            }
        },
    })
}
