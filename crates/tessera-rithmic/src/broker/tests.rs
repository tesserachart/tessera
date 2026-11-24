use std::str::FromStr;
use std::sync::Arc;
use std::time::Duration;

use futures::StreamExt;
use rithmic_rs::RithmicError;
use rithmic_rs::rti::messages::RithmicMessage;
use rithmic_rs::rti::{
    AccountPnLPositionUpdate, AccountRmsUpdates, ExchangeOrderNotification, ForcedLogout,
    InstrumentPnLPositionUpdate, ResponseAccountList, ResponseAccountRmsInfo,
    RithmicOrderNotification,
};
use rust_decimal::Decimal;
use tessera_broker::SendRefused;
use tessera_broker::{BrokerError, BrokerEvent, BrokerProvider, GuardedBroker};
use tessera_core::accounts::Environment;
use tessera_core::instrument::InstrumentId;
use tessera_core::money::{Price, Qty};
use tessera_core::orders::{
    CheckSeverity, OrderRequest, OrderStatus, OrderType, Side, TimeInForce,
};
use tessera_core::time::Timestamp;

use super::*;
use crate::credentials::RithmicLogin;
use crate::session::RithmicOptions;

/// rithmic-rs message structs are `#[non_exhaustive]`, so tests build them from `Default`.
macro_rules! msg {
    ($ty:ident { $($field:ident: $value:expr),* $(,)? }) => {{
        let mut m = $ty::default();
        $(m.$field = $value;)*
        m
    }};
}

const ACCOUNT: &str = "TEST-000001-01";

fn broker(system: &str) -> RithmicBroker {
    broker_at(system, "wss://gateway.invalid:443", Duration::from_secs(20))
}

fn broker_at(system: &str, gateway_url: &str, connect_timeout: Duration) -> RithmicBroker {
    let login = RithmicLogin {
        user: "someone".into(),
        password: "not-a-password".into(),
        system_name: system.into(),
        gateway_url: gateway_url.into(),
    };
    let mut opts = RithmicOptions::for_system(system);
    opts.connect_timeout = connect_timeout;
    let b = RithmicBroker::on_session(Session::new(login, opts).unwrap());
    let info = AccountInfo::from_list(
        b.provider_id(),
        &msg!(ResponseAccountList {
            fcm_id: Some("TestFcm".into()),
            ib_id: Some("TestIb".into()),
            account_id: Some(ACCOUNT.into()),
            account_name: Some("TEST-000001 (Sample)".into()),
            account_currency: Some("USD".into()),
            loss_limit: Some("9999999".into()),
            account_auto_liquidate: Some("enabled".into()),
            auto_liq_threshold_current_value: Some("24000.000000".into()),
        }),
    )
    .unwrap();
    b.inner.install(&[info]);
    b.inner
        .apply_rms_messages(&[&RithmicMessage::ResponseAccountRmsInfo(msg!(
            ResponseAccountRmsInfo {
                account_id: Some(ACCOUNT.into()),
                status: Some("active".into()),
                auto_liquidate: Some(1),
                auto_liquidate_criteria: Some("Limited Trailing Minimum Account Balance".into()),
                auto_liquidate_threshold: Some(1000.0),
                min_account_balance: Some(24000.0),
                loss_limit: Some(9_999_999.0),
                buy_limit: Some(4),
                sell_limit: Some(4),
                max_order_quantity: Some(8),
            }
        ))]);
    b.inner.on_pnl_message(
        &RithmicMessage::AccountPnLPositionUpdate(msg!(AccountPnLPositionUpdate {
            is_snapshot: Some(true),
            account_id: Some(ACCOUNT.into()),
            account_balance: Some("25000.00".into()),
            cash_on_hand: Some("25000.00".into()),
            open_position_pnl: Some("0.00".into()),
            day_pnl: Some("0.00".into()),
            available_buying_power: Some(String::new()),
            min_account_balance: Some("24000.00".into()),
        })),
        None,
    );
    b.inner.link.lock().assume(ConnectionPhase::Live);
    b
}

fn account_id(b: &RithmicBroker) -> AccountId {
    b.inner.state.read().accounts[0].info.id.clone()
}

fn es() -> InstrumentId {
    crate::symbols::instrument_id("ESZ6", "CME")
}

fn request(b: &RithmicBroker) -> OrderRequest {
    OrderRequest {
        account_id: account_id(b),
        instrument: es(),
        side: Side::Buy,
        qty: Qty::from(1),
        order_type: OrderType::Limit,
        limit_price: Price::from_f64(6700.25),
        stop_price: None,
        tif: TimeInForce::Day,
        bracket: None,
        client_order_id: None,
        reduce_only: false,
    }
}

#[tokio::test]
async fn a_prop_login_is_read_as_an_evaluation() {
    let b = broker("Apex");
    let accounts = b.accounts().await.unwrap();
    assert_eq!(accounts.len(), 1);
    let a = &accounts[0];
    assert_eq!(a.environment, Environment::Eval);
    assert_eq!(a.display_name, ACCOUNT);
    assert!(!a.id.as_str().contains("000001"));
    assert_eq!(b.environment_of(&a.id), Some(Environment::Eval));
    assert_eq!(b.system().environment, Environment::Eval);
    assert_eq!(b.id(), "rithmic-apex");

    let s = b.summary(&a.id).await.unwrap();
    assert_eq!(s.balance.amount, Decimal::from(25_000));
    assert_eq!(s.net_liq.amount, Decimal::from(25_000));

    let r = b.risk(&a.id).await.unwrap().unwrap();
    assert_eq!(r.trailing_threshold.unwrap().amount, Decimal::from(24_000));
    assert_eq!(r.trailing_room.unwrap().amount, Decimal::from(1_000));
    assert_eq!(r.daily_loss_limit, None);
    assert_eq!(b.rms(&a.id).unwrap().max_order_quantity, Some(8));

    let mut events = b.events();
    b.inner.on_order_message(
        &RithmicMessage::AccountRmsUpdates(msg!(AccountRmsUpdates {
            account_id: Some(ACCOUNT.into()),
            auto_liq_threshold_current_value: Some("24100.00".into()),
            auto_liq_peak_account_balance: Some("25100.00".into()),
        })),
        None,
    );
    assert!(matches!(events.next().await, Some(BrokerEvent::Account(_))));
    let r = b.risk(&a.id).await.unwrap().unwrap();
    assert_eq!(r.trailing_room.unwrap().amount, Decimal::from(900));
    assert_eq!(r.high_water_mark.unwrap().amount, Decimal::from(25_100));
}

#[tokio::test]
async fn a_prop_login_sends_nothing_until_the_account_is_turned_on() {
    let b = broker("Apex");
    let a = account_id(&b);
    let caps = b.capabilities();
    assert!(caps.read_only);
    assert!(caps.order_types.is_empty());
    assert!(!caps.modify);
    assert_eq!(b.account_order_entry(), Some(vec![]));

    let p = b.preview(&request(&b)).await.unwrap();
    assert!(
        p.checks
            .iter()
            .any(|c| c.code == "order_entry_off" && c.severity == CheckSeverity::Block),
        "{:?}",
        p.checks
    );
    assert!(!p.passes());

    let guarded = GuardedBroker::new(Arc::new(b.clone()));
    b.set_paper_routing(true);
    assert!(matches!(
        guarded.submit(request(&b), None).await,
        Err(BrokerError::Refused(SendRefused::OrderEntryOff))
    ));
    guarded.set_account_order_entry(b.id(), &a, true);
    assert!(matches!(
        guarded.submit(request(&b), None).await,
        Err(BrokerError::Refused(SendRefused::ReadOnly))
    ));
    for template in [312, 314, 316, 330] {
        assert!(matches!(
            b.precheck(template, &a),
            Err(BrokerError::Refused(SendRefused::OrderEntryOff))
        ));
    }
    assert!(
        b.template_counts()
            .keys()
            .all(|id| !crate::templates::ORDER_ENTRY.contains(id))
    );

    b.set_account_order_entry(&a, true).unwrap();
    assert_eq!(b.account_order_entry(), Some(vec![a.clone()]));
    let caps = b.capabilities();
    assert!(!caps.read_only && caps.brackets && caps.modify);
    assert_eq!(caps.order_types.len(), 4);
    assert_eq!(caps.environments, vec![Environment::Eval]);
    let conn = b.connection_of(&a).await.unwrap();
    assert!(!conn.capabilities.read_only);
    let p = b.preview(&request(&b)).await.unwrap();
    assert!(p.passes(), "{:?}", p.checks);
    assert_eq!(
        guarded.route(&a).await.unwrap().environment,
        Environment::Eval
    );
    assert!(matches!(
        guarded.submit(request(&b), None).await,
        Err(BrokerError::Unavailable(_))
    ));
    assert!(b.inner.state.read().accounts[0].in_doubt.is_empty());
    assert_eq!(b.health().status, tessera_core::health::HealthStatus::Ok);

    b.set_account_order_entry(&a, false).unwrap();
    assert!(b.capabilities().read_only);
    assert!(b.connection_of(&a).await.unwrap().capabilities.read_only);
}

#[tokio::test]
async fn live_systems_and_funded_accounts_take_orders_like_an_evaluation() {
    for system in ["Rithmic 01", "Rithmic 04 Colo", "SomeNewFirm"] {
        let b = broker(system);
        let a = account_id(&b);
        assert_eq!(b.environment_of(&a), Some(Environment::Live));
        assert_eq!(b.account_order_entry(), Some(vec![]), "{system}");
        assert!(b.capabilities().read_only, "{system}");
        let p = b.preview(&request(&b)).await.unwrap();
        assert!(
            p.checks.iter().any(|c| c.code == "order_entry_off"),
            "{system}"
        );
        assert!(matches!(
            b.precheck(312, &a),
            Err(BrokerError::Refused(SendRefused::OrderEntryOff))
        ));
        let guarded = GuardedBroker::new(Arc::new(b.clone()));
        assert!(matches!(
            guarded.submit(request(&b), None).await,
            Err(BrokerError::Refused(SendRefused::OrderEntryOff))
        ));
        b.set_account_order_entry(&a, true).unwrap();
        guarded.set_account_order_entry(b.id(), &a, true);
        assert_eq!(b.account_order_entry(), Some(vec![a.clone()]), "{system}");
        assert!(!b.connection_of(&a).await.unwrap().capabilities.read_only);
        assert!(b.precheck(312, &a).is_ok(), "{system}");
        assert_eq!(
            guarded.route(&a).await.unwrap().environment,
            Environment::Live
        );
    }
    let b = broker("Apex");
    let info = AccountInfo::from_list(
        b.provider_id(),
        &msg!(ResponseAccountList {
            fcm_id: Some("TestFcm".into()),
            ib_id: Some("TestIb".into()),
            account_id: Some("PA-TEST-000002".into()),
            account_currency: Some("USD".into()),
        }),
    )
    .unwrap();
    let pa = info.id.clone();
    let first = b.inner.state.read().accounts[0].info.clone();
    b.inner.install(&[first, info]);
    assert_eq!(b.environment_of(&pa), Some(Environment::Funded));
    b.set_account_order_entry(&pa, true).unwrap();
    assert!(b.precheck(312, &pa).is_ok());
}

#[tokio::test]
async fn a_paper_system_needs_both_switches() {
    let b = broker("Rithmic Paper Trading");
    let caps = b.capabilities();
    assert!(caps.read_only && caps.order_types.is_empty() && !caps.modify);
    assert_eq!(caps.environments, vec![Environment::Sim]);
    let a = account_id(&b);
    assert_eq!(b.environment_of(&a), Some(Environment::Sim));
    let p = b.preview(&request(&b)).await.unwrap();
    assert!(
        p.checks
            .iter()
            .any(|c| c.code == "routing_disabled" && c.severity == CheckSeverity::Block)
    );

    let guarded = GuardedBroker::new(Arc::new(b.clone()));
    assert!(matches!(
        guarded.submit(request(&b), None).await,
        Err(BrokerError::Refused(SendRefused::ReadOnly))
    ));
    b.set_paper_routing(true);
    assert!(!b.capabilities().read_only);
    assert!(matches!(
        guarded.submit(request(&b), None).await,
        Err(BrokerError::Unavailable(_))
    ));
}

#[tokio::test]
async fn a_replayed_execution_is_held_but_not_announced_as_a_new_fill() {
    let b = broker("Apex");
    let a = account_id(&b);
    let mut events = b.events();
    b.inner.on_order_message(
        &RithmicMessage::ExchangeOrderNotification(msg!(ExchangeOrderNotification {
            account_id: Some(ACCOUNT.into()),
            is_snapshot: Some(true),
            notify_type: Some(5),
            basket_id: Some("B3".into()),
            fill_id: Some("F3".into()),
            symbol: Some("ESZ6".into()),
            exchange: Some("CME".into()),
            transaction_type: Some(1),
            fill_price: Some(6700.0),
            fill_size: Some(1),
            source_ssboe: Some(1_791_390_000),
        })),
        None,
    );
    hold_everything(&b);
    assert_eq!(b.fills(&a, Timestamp(0)).await.unwrap().len(), 1);
    assert!(
        tokio::time::timeout(Duration::from_millis(50), events.next())
            .await
            .is_err(),
        "a fill from before this session is not a new fill"
    );
}

fn hold_everything(b: &RithmicBroker) {
    let c = &mut b.inner.state.write().accounts[0].coverage;
    c.replayed(fill_days::trade_date(Timestamp::now()));
    c.fetched(NaiveDate::MIN);
}

#[tokio::test]
async fn plant_updates_become_positions_orders_and_fills() {
    let b = broker("Apex");
    let a = account_id(&b);
    let mut events = b.events();

    b.inner.on_pnl_message(
        &RithmicMessage::InstrumentPnLPositionUpdate(msg!(InstrumentPnLPositionUpdate {
            account_id: Some(ACCOUNT.into()),
            symbol: Some("ESZ6".into()),
            exchange: Some("CME".into()),
            net_quantity: Some(1),
            avg_open_fill_price: Some(6700.25),
            open_position_pnl: Some("-12.50".into()),
        })),
        None,
    );
    let Some(BrokerEvent::Position(p)) = events.next().await else {
        panic!("a position event")
    };
    assert_eq!(p.qty, Qty::from(1));
    assert_eq!(b.positions(&a).await.unwrap().len(), 1);

    b.inner.on_order_message(
        &RithmicMessage::RithmicOrderNotification(msg!(RithmicOrderNotification {
            account_id: Some(ACCOUNT.into()),
            basket_id: Some("B7".into()),
            symbol: Some("ESZ6".into()),
            exchange: Some("CME".into()),
            status: Some("open".into()),
            quantity: Some(1),
            price: Some(6710.0),
            price_type: Some(1),
            transaction_type: Some(2),
            duration: Some(1),
        })),
        None,
    );
    let Some(BrokerEvent::Order(o)) = events.next().await else {
        panic!("an order event")
    };
    assert_eq!(o.status, OrderStatus::Working);
    assert_eq!(o.request.side, Side::Sell);
    assert_eq!(b.order_of(&o.id).unwrap().id, o.id);
    assert_eq!(b.orders(&a).await.unwrap().len(), 1);

    let fill = msg!(ExchangeOrderNotification {
        account_id: Some(ACCOUNT.into()),
        notify_type: Some(5),
        basket_id: Some("B7".into()),
        fill_id: Some("F1".into()),
        symbol: Some("ESZ6".into()),
        exchange: Some("CME".into()),
        transaction_type: Some(2),
        fill_price: Some(6710.0),
        fill_size: Some(1),
        source_ssboe: Some(1_791_390_000),
    });
    b.inner.on_order_message(
        &RithmicMessage::ExchangeOrderNotification(fill.clone()),
        None,
    );
    let Some(BrokerEvent::Fill(f)) = events.next().await else {
        panic!("a fill event")
    };
    assert_eq!(f.order_id.as_ref(), Some(&o.id));
    b.inner
        .on_order_message(&RithmicMessage::ExchangeOrderNotification(fill), None);
    hold_everything(&b);
    assert_eq!(b.fills(&a, Timestamp(0)).await.unwrap().len(), 1);
    assert!(
        b.fills(&a, Timestamp::from_secs(1_791_390_001))
            .await
            .unwrap()
            .is_empty()
    );

    b.inner.on_pnl_message(
        &RithmicMessage::InstrumentPnLPositionUpdate(msg!(InstrumentPnLPositionUpdate {
            account_id: Some(ACCOUNT.into()),
            symbol: Some("ESZ6".into()),
            exchange: Some("CME".into()),
            net_quantity: Some(0),
        })),
        None,
    );
    let Some(BrokerEvent::Position(p)) = events.next().await else {
        panic!("a closing position event")
    };
    assert!(p.qty.is_zero());
    assert!(b.positions(&a).await.unwrap().is_empty());

    b.inner.on_pnl_message(
        &RithmicMessage::AccountPnLPositionUpdate(msg!(AccountPnLPositionUpdate {
            account_id: Some("SOMEONE-ELSE".into()),
            account_balance: Some("1.00".into()),
        })),
        None,
    );
    assert_eq!(
        b.summary(&a).await.unwrap().balance.amount,
        Decimal::from_str("25000").unwrap()
    );
}

#[tokio::test]
async fn forced_logout_and_drops_end_the_account_plants() {
    let b = broker("Apex");
    let forced = RithmicMessage::ForcedLogout(ForcedLogout::default());
    assert_eq!(b.inner.on_order_message(&forced, None), Some(End::Forced));
    assert_eq!(b.inner.on_pnl_message(&forced, None), Some(End::Forced));
    assert!(matches!(
        b.inner.on_pnl_message(
            &RithmicMessage::HeartbeatTimeout,
            Some(&RithmicError::HeartbeatTimeout)
        ),
        Some(End::Lost(_))
    ));
    let fresh = RithmicBroker::on_session(Arc::clone(&b.inner.session));
    assert!(matches!(
        fresh.accounts().await,
        Err(BrokerError::Unavailable(_))
    ));
    assert!(matches!(
        b.summary(&AccountId::new("rithmic-apex-unknown")).await,
        Err(BrokerError::NotFound(_))
    ));
    assert_eq!(
        fresh.health().status,
        tessera_core::health::HealthStatus::Disconnected
    );
}

fn logged_out(attempt: u32) -> ConnectionPhase {
    ConnectionPhase::Reconnecting {
        attempt,
        reason: crate::session::LOGGED_OUT.into(),
    }
}

#[tokio::test]
async fn a_forced_logout_reads_as_a_reconnect_on_prices_and_a_wait_on_accounts() {
    let b = broker("Apex");
    let session = &b.inner.session;
    let generation = session.assume(ConnectionPhase::Live);
    session.forced_logout("ticker", generation);
    let generation = b.inner.link.lock().generation();
    assert!(b.inner.advance(generation, Event::Waiting));
    let prices = session.health();
    assert_eq!(
        (prices.status, prices.connection, prices.message),
        (HealthStatus::Degraded, Some(logged_out(1)), None)
    );
    let accounts = b.health();
    assert_eq!(
        (accounts.status, accounts.connection, accounts.message),
        (HealthStatus::Degraded, Some(ConnectionPhase::Waiting), None)
    );
}

#[tokio::test]
async fn every_plant_of_one_forced_logout_is_one_logout() {
    let b = broker("Apex");
    let session = &b.inner.session;
    let generation = session.assume(ConnectionPhase::Live);
    session.forced_logout("ticker", generation);
    session.forced_logout("order", generation);
    session.forced_logout("history", generation);
    assert_eq!(
        (session.phase(), session.generation()),
        (logged_out(1), generation + 1),
        "the plants of one logout are one logout"
    );
}

#[tokio::test]
async fn a_forced_logout_after_a_stop_changes_nothing() {
    let b = broker("Apex");
    let session = &b.inner.session;
    let generation = session.assume(ConnectionPhase::Live);
    session.shutdown().await;
    session.forced_logout("history", generation);
    assert_eq!(session.phase(), ConnectionPhase::Stopped);
    assert!(!session.gate.is_closed());
}

#[tokio::test(start_paused = true)]
async fn accounts_waiting_on_a_session_another_login_took_over_go_down_and_stop_waiting() {
    let b = broker("Apex");
    let generation = b.inner.link.lock().generation();
    b.inner.session.assume(logged_out(1));
    let inner = Arc::clone(&b.inner);
    let waiting =
        tokio::spawn(async move { inner.recover(generation, Wait::Forced).await.is_none() });
    tokio::time::sleep(Duration::from_secs(5)).await;
    assert_eq!(b.phase(), ConnectionPhase::Waiting);
    assert!(!waiting.is_finished());

    b.inner.session.assume(ConnectionPhase::TakenOver);
    assert!(waiting.await.unwrap(), "no longer waiting");
    let health = b.health();
    assert_eq!(
        (health.status, health.connection),
        (HealthStatus::Down, Some(ConnectionPhase::TakenOver))
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_stop_while_the_accounts_log_in_again_stays_stopped() {
    let silent = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("ws://{}", silent.local_addr().unwrap());
    let (knock, mut knocked) = tokio::sync::mpsc::unbounded_channel();
    tokio::spawn(async move {
        let mut held = Vec::new();
        while let Ok((tcp, _)) = silent.accept().await {
            held.push(tcp);
            let _ = knock.send(());
        }
    });
    let b = broker_at("Apex", &url, Duration::from_millis(500));
    let generation = b.inner.link.lock().generation();
    let inner = Arc::clone(&b.inner);
    let recovering = tokio::spawn(async move {
        inner
            .recover(generation, Wait::Backoff("heartbeat timeout".into()))
            .await
            .is_none()
    });
    knocked.recv().await.unwrap();
    b.shutdown().await;
    assert!(recovering.await.unwrap());
    let health = b.health();
    assert_eq!(
        (b.phase(), health.status, health.connection),
        (
            ConnectionPhase::Stopped,
            HealthStatus::Disconnected,
            Some(ConnectionPhase::Stopped)
        )
    );
}

#[tokio::test]
async fn rithmics_account_limits_are_said_and_refuse_nothing_by_themselves() {
    let b = broker("Apex");
    let a = account_id(&b);
    b.set_account_order_entry(&a, true).unwrap();
    let mnq = crate::symbols::instrument_id("MNQZ6", "CME");
    let order = |side: Side, qty: i64| OrderRequest {
        instrument: mnq.clone(),
        side,
        qty: Qty::from(qty),
        ..request(&b)
    };
    for (side, word) in [(Side::Buy, "buy"), (Side::Sell, "sell")] {
        let p = b.preview(&order(side, 5)).await.unwrap();
        assert!(p.passes(), "{side:?}: {:?}", p.checks);
        let c = p
            .checks
            .iter()
            .find(|c| c.code == "max_position")
            .expect("the reported limit is said");
        assert_eq!(c.severity, CheckSeverity::Info);
        assert_eq!(
            c.message,
            format!(
                "Rithmic reports an account {word} limit of 4; Rithmic refuses the order itself \
                 if it is over the account's limits."
            )
        );
        let p = b.preview(&order(side, 4)).await.unwrap();
        assert!(p.checks.iter().all(|c| c.code != "max_position"));
    }
    let p = b.preview(&order(Side::Buy, 9)).await.unwrap();
    assert!(p.passes(), "{:?}", p.checks);
    assert!(p.checks.iter().any(|c| {
        c.code == "max_order_size"
            && c.severity == CheckSeverity::Info
            && c.message
                .starts_with("Rithmic reports an account order limit of 8;")
    }));
    let risk = b.risk(&a).await.unwrap().unwrap();
    assert_eq!(
        risk.contract_limits,
        Some(tessera_core::accounts::ContractLimits {
            buy: Some(4),
            sell: Some(4),
            per_order: Some(8),
        })
    );
}

#[tokio::test]
async fn events_leave_in_the_order_their_changes_were_made() {
    const THREADS: usize = 4;
    const CHANGES: usize = 1_000;
    let b = broker("Apex");
    let mut events = b.inner.events.subscribe();
    let threads: Vec<_> = (0..THREADS)
        .map(|_| {
            let inner = Arc::clone(&b.inner);
            std::thread::spawn(move || {
                for _ in 0..CHANGES {
                    inner.change(|state, out| {
                        let e = &mut state.accounts[0];
                        let n = e.tags.len();
                        e.tags.insert(n.to_string(), OrderId::new(n.to_string()));
                        out.push(BrokerEvent::Disconnected {
                            reason: n.to_string(),
                        });
                    });
                }
            })
        })
        .collect();
    for t in threads {
        t.join().unwrap();
    }
    let mut seen = Vec::new();
    while let Ok(BrokerEvent::Disconnected { reason }) = events.try_recv() {
        seen.push(reason.parse::<usize>().unwrap());
    }
    assert_eq!(seen, (0..THREADS * CHANGES).collect::<Vec<_>>());
}
