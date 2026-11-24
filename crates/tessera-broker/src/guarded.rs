use std::collections::{BTreeSet, HashMap};
use std::sync::Arc;

use parking_lot::{Mutex, RwLock};
use tessera_core::Qty;
use tessera_core::accounts::Environment;
use tessera_core::ids::{AccountId, DraftId, OrderId};
use tessera_core::instrument::InstrumentId;
use tessera_core::orders::{Bracket, Order, OrderRequest, OrderRole, Side};

use crate::guard::{SendPathGuard, SendRefused};
use crate::{BrokerError, BrokerProvider, OrderChanges};

#[derive(Debug)]
pub struct Verified {
    _private: (),
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Route {
    pub connection: String,
    pub system: String,
    pub environment: Environment,
}

pub struct GuardedBroker<P: BrokerProvider + ?Sized> {
    provider: Arc<P>,
    guard: SendPathGuard,
    order_entry: RwLock<BTreeSet<(String, AccountId)>>,
    turns: Mutex<HashMap<OrderId, Arc<tokio::sync::Mutex<()>>>>,
}

impl<P: BrokerProvider + ?Sized> std::fmt::Debug for GuardedBroker<P> {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("GuardedBroker")
            .field("provider", &self.provider.id())
            .finish_non_exhaustive()
    }
}

pub const NOTHING_TO_CLOSE: &str = "No open position for this exit to close; nothing sent.";

fn mismatch(what: impl Into<String>) -> BrokerError {
    BrokerError::Refused(SendRefused::Mismatch(what.into()))
}

impl<P: BrokerProvider + ?Sized> GuardedBroker<P> {
    pub fn new(provider: Arc<P>) -> Self {
        Self {
            provider,
            guard: SendPathGuard::default(),
            order_entry: RwLock::new(BTreeSet::new()),
            turns: Mutex::new(HashMap::new()),
        }
    }

    pub fn provider(&self) -> &Arc<P> {
        &self.provider
    }

    pub fn set_account_order_entry(&self, connection: &str, account: &AccountId, enabled: bool) {
        let key = (connection.to_owned(), account.clone());
        let mut set = self.order_entry.write();
        if enabled {
            set.insert(key);
        } else {
            set.remove(&key);
        }
    }

    pub fn account_order_entry(&self, connection: &str, account: &AccountId) -> bool {
        self.order_entry
            .read()
            .contains(&(connection.to_owned(), account.clone()))
    }

    pub async fn route(&self, account: &AccountId) -> Result<Route, BrokerError> {
        let accounts = self.provider.accounts().await?;
        let environment = accounts
            .iter()
            .find(|a| &a.id == account)
            .map(|a| a.environment)
            .ok_or_else(|| SendRefused::UnknownAccount(account.clone()))?;
        let connection = self.provider.connection_of(account).await?;
        self.guard.check(
            &connection.system,
            environment,
            connection.capabilities.read_only,
            self.account_order_entry(&connection.id, account),
        )?;
        Ok(Route {
            connection: connection.id,
            system: connection.system.name,
            environment,
        })
    }

    async fn verified(&self, account: &AccountId) -> Result<Verified, BrokerError> {
        self.route(account).await?;
        Ok(Verified { _private: () })
    }

    pub async fn submit(
        &self,
        request: OrderRequest,
        draft: Option<DraftId>,
    ) -> Result<Order, BrokerError> {
        let verified = self.verified(&request.account_id).await?;
        let request = self.fit_exit(request).await?;
        self.provider.submit(&verified, request, draft).await
    }

    pub async fn closable(
        &self,
        account: &AccountId,
        instrument: &InstrumentId,
        side: Side,
    ) -> Result<Qty, BrokerError> {
        let held = self.provider.fresh_position(account, instrument).await?.0;
        Ok(if Side::holding(held) == Some(side.opposite()) {
            Qty(held.abs())
        } else {
            Qty::ZERO
        })
    }

    async fn fit_exit(&self, mut request: OrderRequest) -> Result<OrderRequest, BrokerError> {
        if !request.reduce_only {
            return Ok(request);
        }
        let room = self
            .closable(&request.account_id, &request.instrument, request.side)
            .await?;
        if room.is_zero() {
            return Err(BrokerError::Rejected(NOTHING_TO_CLOSE.into()));
        }
        if request.qty > room {
            tracing::warn!(
                account = %request.account_id,
                asked = %request.qty,
                sent = %room,
                "an exit larger than the position goes out at the position's size"
            );
            request.qty = room;
        }
        Ok(request)
    }

    async fn fit_exit_change(
        &self,
        order: &OrderId,
        mut changes: OrderChanges,
    ) -> Result<OrderChanges, BrokerError> {
        let (Some(want), Some(o)) = (changes.qty, self.provider.order_of(order)) else {
            return Ok(changes);
        };
        let exit =
            o.request.reduce_only || matches!(o.role, OrderRole::StopLoss | OrderRole::TakeProfit);
        if !exit || want <= o.request.qty {
            return Ok(changes);
        }
        let room = self
            .closable(&o.request.account_id, &o.request.instrument, o.request.side)
            .await?;
        let most = Qty(o.filled_qty.0 + room.0);
        if most <= o.request.qty {
            return Err(BrokerError::Rejected(
                "The position is no larger than this exit already; it stays as it is.".into(),
            ));
        }
        changes.qty = Some(want.min(most));
        Ok(changes)
    }

    async fn turn_of(&self, order: &OrderId) -> tokio::sync::OwnedMutexGuard<()> {
        let turn = {
            let mut turns = self.turns.lock();
            turns.retain(|_, t| Arc::strong_count(t) > 1);
            Arc::clone(turns.entry(order.clone()).or_default())
        };
        turn.lock_owned().await
    }

    fn check_order_account(&self, account: &AccountId, order: &OrderId) -> Result<(), BrokerError> {
        match self.provider.order_of(order) {
            Some(o) if &o.request.account_id != account => Err(mismatch(format!(
                "order {order} belongs to account {}, not {account}",
                o.request.account_id
            ))),
            _ => Ok(()),
        }
    }

    pub async fn modify(
        &self,
        account: &AccountId,
        order: &OrderId,
        changes: OrderChanges,
    ) -> Result<Order, BrokerError> {
        self.check_order_account(account, order)?;
        let _turn = self.turn_of(order).await;
        let verified = self.verified(account).await?;
        let changes = self.fit_exit_change(order, changes).await?;
        self.provider.modify(&verified, order, changes).await
    }

    pub async fn cancel(&self, account: &AccountId, order: &OrderId) -> Result<Order, BrokerError> {
        self.check_order_account(account, order)?;
        let _turn = self.turn_of(order).await;
        let verified = self.verified(account).await?;
        self.provider.cancel(&verified, order).await
    }

    pub async fn attach(
        &self,
        account: &AccountId,
        order: &OrderId,
        bracket: Bracket,
        qty: Qty,
    ) -> Result<Vec<Order>, BrokerError> {
        self.check_order_account(account, order)?;
        let verified = self.verified(account).await?;
        self.provider
            .attach_bracket(&verified, order, bracket, qty)
            .await
    }
}

#[cfg(test)]
mod tests {
    use std::collections::BTreeMap;

    use super::*;
    use crate::{BrokerEvent, BrokerSystem};
    use async_trait::async_trait;
    use futures::stream::BoxStream;
    use parking_lot::Mutex;
    use tessera_core::accounts::{AccountSummary, Restrictions, TradingAccount};
    use tessera_core::capabilities::BrokerCapabilities;
    use tessera_core::health::{HealthStatus, ProviderHealth, ProviderKind};
    use tessera_core::ids::{BrokerId, ConnectionId};
    use tessera_core::orders::{
        Fill, OrderPreview, OrderRole, OrderStatus, OrderType, Position, Side, TimeInForce,
    };
    use tessera_core::{Currency, InstrumentId, Qty, Timestamp};

    struct Fake {
        id: &'static str,
        system: BrokerSystem,
        accounts: Vec<(&'static str, Environment)>,
        read_only: bool,
        sent: Mutex<Vec<String>>,
        held: Vec<(&'static str, &'static str)>,
    }

    impl Fake {
        fn paper(id: &'static str) -> Arc<Self> {
            Arc::new(Self {
                id,
                system: BrokerSystem {
                    name: "Tessera Paper".into(),
                    environment: Environment::Paper,
                },
                accounts: vec![
                    ("paper-x", Environment::Paper),
                    ("paper-y", Environment::Paper),
                ],
                read_only: false,
                sent: Mutex::default(),
                held: Vec::new(),
            })
        }

        fn order(&self, request: OrderRequest) -> Order {
            Order {
                id: OrderId::new("o1"),
                broker_order_id: None,
                draft_id: None,
                request,
                role: OrderRole::Entry,
                parent_id: None,
                status: OrderStatus::Working,
                filled_qty: Qty::ZERO,
                avg_fill_price: None,
                queue_ahead: None,
                stop_rules: None,
                triggered_at: None,
                environment: Environment::Paper,
                reason: None,
                created_at: Timestamp(0),
                updated_at: Timestamp(0),
            }
        }
    }

    #[async_trait]
    impl BrokerProvider for Fake {
        fn id(&self) -> &str {
            self.id
        }
        fn capabilities(&self) -> BrokerCapabilities {
            BrokerCapabilities {
                order_types: vec![OrderType::Market],
                time_in_force: vec![TimeInForce::Day],
                brackets: false,
                oco: false,
                modify: true,
                read_only: self.read_only,
                environments: vec![Environment::Paper],
                fractional_qty: false,
                stop_rules: false,
            }
        }
        fn system(&self) -> BrokerSystem {
            self.system.clone()
        }
        fn environment_of(&self, account: &AccountId) -> Option<Environment> {
            self.accounts
                .iter()
                .find(|(id, _)| *id == account.as_str())
                .map(|(_, env)| *env)
        }
        fn order_of(&self, order: &OrderId) -> Option<Order> {
            self.held
                .iter()
                .find(|(id, _)| *id == order.as_str())
                .map(|(id, account)| Order {
                    id: OrderId::new(*id),
                    ..self.order(request(account, 1))
                })
        }
        fn health(&self) -> ProviderHealth {
            ProviderHealth {
                provider_id: self.id.into(),
                kind: ProviderKind::Broker,
                display_name: self.id.into(),
                status: HealthStatus::Ok,
                latency_ms: None,
                last_message_at: None,
                message: None,
                connection: None,
                accounts: None,
                checked_at: Timestamp(0),
            }
        }
        async fn accounts(&self) -> Result<Vec<TradingAccount>, BrokerError> {
            Ok(self
                .accounts
                .iter()
                .map(|(id, env)| TradingAccount {
                    id: AccountId::new(*id),
                    display_name: (*id).into(),
                    environment: *env,
                    broker_id: BrokerId::new("paper"),
                    connection_id: ConnectionId::new(self.id),
                    program_id: None,
                    rule_set_id: None,
                    currency: Currency::Usd,
                    restrictions: Restrictions::default(),
                    group_id: None,
                    external_ref_masked: None,
                })
                .collect())
        }
        async fn summary(&self, _: &AccountId) -> Result<AccountSummary, BrokerError> {
            Err(BrokerError::Unsupported("summary".into()))
        }
        async fn positions(&self, _: &AccountId) -> Result<Vec<Position>, BrokerError> {
            Ok(vec![])
        }
        async fn orders(&self, _: &AccountId) -> Result<Vec<Order>, BrokerError> {
            Ok(vec![])
        }
        async fn fills(&self, _: &AccountId, _: Timestamp) -> Result<Vec<Fill>, BrokerError> {
            Ok(vec![])
        }
        async fn preview(&self, _: &OrderRequest) -> Result<OrderPreview, BrokerError> {
            Err(BrokerError::Unsupported("preview".into()))
        }
        async fn submit(
            &self,
            _: &Verified,
            request: OrderRequest,
            _: Option<DraftId>,
        ) -> Result<Order, BrokerError> {
            self.sent
                .lock()
                .push(format!("submit {}", request.account_id));
            Ok(self.order(request))
        }
        async fn modify(
            &self,
            _: &Verified,
            order: &OrderId,
            _: OrderChanges,
        ) -> Result<Order, BrokerError> {
            self.sent.lock().push(format!("modify {order}"));
            Err(BrokerError::NotFound(order.to_string()))
        }
        async fn cancel(&self, _: &Verified, order: &OrderId) -> Result<Order, BrokerError> {
            self.sent.lock().push(format!("cancel {order}"));
            Err(BrokerError::NotFound(order.to_string()))
        }
        fn events(&self) -> BoxStream<'static, BrokerEvent> {
            Box::pin(futures::stream::empty())
        }
    }

    fn request(account: &str, qty: i64) -> OrderRequest {
        OrderRequest {
            account_id: AccountId::new(account),
            instrument: InstrumentId::new("MNQZ6.CME").unwrap(),
            side: Side::Buy,
            qty: Qty::from(qty),
            order_type: OrderType::Market,
            limit_price: None,
            stop_price: None,
            tif: TimeInForce::Day,
            bracket: None,
            client_order_id: None,
            reduce_only: false,
        }
    }

    fn guarded(p: Arc<Fake>) -> GuardedBroker<Fake> {
        GuardedBroker::new(p)
    }

    fn refused<T: std::fmt::Debug>(r: Result<T, BrokerError>) -> SendRefused {
        match r {
            Err(BrokerError::Refused(why)) => why,
            other => panic!("expected a refusal, got {other:?}"),
        }
    }

    fn prop(id: &'static str, accounts: Vec<(&'static str, Environment)>) -> Arc<Fake> {
        Arc::new(Fake {
            system: BrokerSystem {
                name: "Apex".into(),
                environment: Environment::Eval,
            },
            accounts,
            ..Arc::try_unwrap(Fake::paper(id)).ok().unwrap()
        })
    }

    #[tokio::test]
    async fn one_call_checks_and_sends_each_kind_of_order() {
        let a = Fake::paper("paper-a");
        let broker = guarded(Arc::clone(&a));
        let account = AccountId::new("paper-x");
        let order = OrderId::new("o1");
        broker.submit(request("paper-x", 1), None).await.unwrap();
        let _ = broker
            .modify(&account, &order, OrderChanges::default())
            .await;
        let _ = broker.cancel(&account, &order).await;
        let attached = broker
            .attach(&account, &order, Bracket::default(), Qty::from(1))
            .await;
        assert!(matches!(attached, Err(BrokerError::Unsupported(_))));
        assert_eq!(*a.sent.lock(), ["submit paper-x", "modify o1", "cancel o1"]);
    }

    #[tokio::test]
    async fn a_route_names_the_accounts_own_connection_system_and_type() {
        let broker = guarded(Fake::paper("paper-a"));
        assert_eq!(
            broker.route(&AccountId::new("paper-x")).await.unwrap(),
            Route {
                connection: "paper-a".into(),
                system: "Tessera Paper".into(),
                environment: Environment::Paper,
            }
        );
        let why = refused(broker.route(&AccountId::new("not-here")).await);
        assert!(matches!(why, SendRefused::UnknownAccount(_)), "{why}");
    }

    #[tokio::test]
    async fn rules_use_the_connections_own_account_environment() {
        let funded = prop("rithmic", vec![("apex-1", Environment::Funded)]);
        let broker = guarded(Arc::clone(&funded));
        let why = refused(broker.submit(request("apex-1", 1), None).await);
        assert_eq!(why, SendRefused::OrderEntryOff);
        let why = refused(broker.submit(request("not-here", 1), None).await);
        assert!(matches!(why, SendRefused::UnknownAccount(_)), "{why}");
        assert!(funded.sent.lock().is_empty());
    }

    #[tokio::test]
    async fn order_entry_is_read_at_the_moment_of_each_send() {
        let p = prop("rithmic-apex", vec![("apex-1", Environment::Eval)]);
        let broker = guarded(Arc::clone(&p));
        let apex_1 = AccountId::new("apex-1");
        broker.set_account_order_entry("rithmic-apex", &apex_1, true);
        broker.submit(request("apex-1", 1), None).await.unwrap();
        broker.set_account_order_entry("rithmic-apex", &apex_1, false);
        let order = OrderId::new("o1");
        for why in [
            refused(broker.submit(request("apex-1", 1), None).await),
            refused(
                broker
                    .modify(&apex_1, &order, OrderChanges::default())
                    .await,
            ),
            refused(broker.cancel(&apex_1, &order).await),
            refused(
                broker
                    .attach(&apex_1, &order, Bracket::default(), Qty::from(1))
                    .await,
            ),
        ] {
            assert_eq!(why, SendRefused::OrderEntryOff);
        }
        assert_eq!(*p.sent.lock(), ["submit apex-1"]);
    }

    #[tokio::test]
    async fn read_only_connections_and_switched_off_accounts_send_nothing() {
        let ro = Arc::new(Fake {
            read_only: true,
            ..Arc::try_unwrap(Fake::paper("paper-ro")).ok().unwrap()
        });
        let why = refused(
            guarded(Arc::clone(&ro))
                .submit(request("paper-x", 1), None)
                .await,
        );
        assert_eq!(why, SendRefused::ReadOnly);
        let apex = Arc::new(Fake {
            system: BrokerSystem {
                name: "Apex".into(),
                environment: Environment::Sim,
            },
            ..Arc::try_unwrap(Fake::paper("apex")).ok().unwrap()
        });
        let why = refused(
            guarded(Arc::clone(&apex))
                .submit(request("paper-x", 1), None)
                .await,
        );
        assert_eq!(why, SendRefused::OrderEntryOff);
        assert!(ro.sent.lock().is_empty() && apex.sent.lock().is_empty());
    }

    fn prop_and_paper() -> (Arc<Fake>, Arc<Fake>, Arc<crate::BrokerRouter>) {
        let paper = Fake::paper("paper-a");
        let prop = Arc::new(Fake {
            read_only: true,
            ..Arc::try_unwrap(prop("rithmic-apex", vec![("apex-1", Environment::Eval)]))
                .ok()
                .unwrap()
        });
        let router = crate::BrokerRouter::new();
        router.add(Arc::clone(&paper) as _).unwrap();
        router.add(Arc::clone(&prop) as _).unwrap();
        (paper, prop, router)
    }

    #[tokio::test]
    async fn a_router_checks_and_sends_on_each_accounts_own_connection() {
        let (paper, prop, router) = prop_and_paper();
        let broker = GuardedBroker::new(Arc::clone(&router) as Arc<dyn BrokerProvider>);
        assert_eq!(router.accounts().await.unwrap().len(), 3);

        let route = broker.route(&AccountId::new("paper-x")).await.unwrap();
        assert_eq!(route.connection, "paper-a");
        broker.submit(request("paper-x", 1), None).await.unwrap();
        assert_eq!(*paper.sent.lock(), ["submit paper-x"]);

        let why = refused(broker.submit(request("apex-1", 1), None).await);
        assert_eq!(why, SendRefused::OrderEntryOff);
        broker.set_account_order_entry("rithmic-apex", &AccountId::new("apex-1"), true);
        let why = refused(broker.submit(request("apex-1", 1), None).await);
        assert_eq!(why, SendRefused::ReadOnly);
        broker.set_account_order_entry("rithmic-apex", &AccountId::new("apex-1"), false);
        broker.set_account_order_entry("paper-a", &AccountId::new("apex-1"), true);
        let why = refused(broker.submit(request("apex-1", 1), None).await);
        assert_eq!(why, SendRefused::OrderEntryOff);
        assert!(prop.sent.lock().is_empty());
    }

    #[tokio::test]
    async fn the_users_account_type_wins_and_never_opens_order_entry() {
        let (_paper, prop, router) = prop_and_paper();
        let broker = GuardedBroker::new(Arc::clone(&router) as Arc<dyn BrokerProvider>);
        let apex_1 = AccountId::new("apex-1");
        let env_in_list = |accounts: Vec<TradingAccount>| {
            accounts
                .into_iter()
                .find(|a| a.id == apex_1)
                .map(|a| a.environment)
        };
        assert_eq!(router.environment_of(&apex_1), Some(Environment::Eval));

        router.set_account_types([(apex_1.clone(), Environment::Funded)].into());
        assert_eq!(router.environment_of(&apex_1), Some(Environment::Funded));
        assert_eq!(
            env_in_list(router.accounts().await.unwrap()),
            Some(Environment::Funded)
        );
        assert_eq!(
            router.environment_of(&AccountId::new("paper-x")),
            Some(Environment::Paper),
            "an account left out keeps what its connection reports"
        );

        router.set_account_types([(apex_1.clone(), Environment::Sim)].into());
        let why = refused(broker.submit(request("apex-1", 1), None).await);
        assert_eq!(why, SendRefused::OrderEntryOff);
        assert!(prop.sent.lock().is_empty());

        router.set_account_types(BTreeMap::new());
        assert_eq!(
            env_in_list(router.accounts().await.unwrap()),
            Some(Environment::Eval)
        );
    }

    #[tokio::test]
    async fn a_prop_evaluation_turned_on_takes_orders_and_off_again_does_not() {
        let prop = prop(
            "rithmic-apex",
            vec![
                ("apex-1", Environment::Eval),
                ("apex-pa", Environment::Funded),
            ],
        );
        let broker = guarded(Arc::clone(&prop));
        let apex_1 = AccountId::new("apex-1");
        let why = refused(broker.submit(request("apex-1", 1), None).await);
        assert_eq!(why, SendRefused::OrderEntryOff);
        broker.set_account_order_entry("rithmic-apex", &apex_1, true);
        assert!(broker.account_order_entry("rithmic-apex", &apex_1));
        assert_eq!(
            broker.route(&apex_1).await.unwrap().environment,
            Environment::Eval
        );
        broker.submit(request("apex-1", 1), None).await.unwrap();
        assert_eq!(*prop.sent.lock(), ["submit apex-1"]);
        broker.set_account_order_entry("rithmic-apex", &apex_1, false);
        let why = refused(broker.submit(request("apex-1", 2), None).await);
        assert_eq!(why, SendRefused::OrderEntryOff);
        let apex_pa = AccountId::new("apex-pa");
        let why = refused(broker.submit(request("apex-pa", 1), None).await);
        assert_eq!(why, SendRefused::OrderEntryOff);
        broker.set_account_order_entry("rithmic-apex", &apex_pa, true);
        assert_eq!(
            broker.route(&apex_pa).await.unwrap().environment,
            Environment::Funded
        );
        broker.submit(request("apex-pa", 1), None).await.unwrap();
        assert_eq!(*prop.sent.lock(), ["submit apex-1", "submit apex-pa"]);
    }

    #[tokio::test]
    async fn a_live_account_on_a_live_system_takes_orders_by_its_switch() {
        let live = Arc::new(Fake {
            system: BrokerSystem {
                name: "Rithmic 01".into(),
                environment: Environment::Live,
            },
            accounts: vec![("live-1", Environment::Live)],
            ..Arc::try_unwrap(Fake::paper("rithmic-live")).ok().unwrap()
        });
        let broker = guarded(Arc::clone(&live));
        let live_1 = AccountId::new("live-1");
        let why = refused(broker.submit(request("live-1", 1), None).await);
        assert_eq!(why, SendRefused::OrderEntryOff);
        assert!(live.sent.lock().is_empty());
        broker.set_account_order_entry("rithmic-live", &live_1, true);
        assert_eq!(
            broker.route(&live_1).await.unwrap().environment,
            Environment::Live
        );
        broker.submit(request("live-1", 1), None).await.unwrap();
        assert_eq!(*live.sent.lock(), ["submit live-1"]);
    }

    #[tokio::test]
    async fn one_connections_account_never_reaches_anothers_order() {
        let paper = Fake::paper("paper-a");
        let prop = Arc::new(Fake {
            read_only: true,
            held: vec![("apex-order", "apex-1")],
            ..Arc::try_unwrap(prop("rithmic-apex", vec![("apex-1", Environment::Eval)]))
                .ok()
                .unwrap()
        });
        let router = crate::BrokerRouter::new();
        router.add(Arc::clone(&paper) as _).unwrap();
        router.add(Arc::clone(&prop) as _).unwrap();
        let broker = GuardedBroker::new(Arc::clone(&router) as Arc<dyn BrokerProvider>);
        let paper_x = AccountId::new("paper-x");
        let theirs = OrderId::new("apex-order");

        let why = refused(broker.cancel(&paper_x, &theirs).await);
        assert!(matches!(why, SendRefused::Mismatch(_)), "{why}");
        let why = refused(
            broker
                .modify(&paper_x, &theirs, OrderChanges::default())
                .await,
        );
        assert!(matches!(why, SendRefused::Mismatch(_)), "{why}");
        let why = refused(
            broker
                .attach(&paper_x, &theirs, Bracket::default(), Qty::from(1))
                .await,
        );
        assert!(matches!(why, SendRefused::Mismatch(_)), "{why}");
        assert!(prop.sent.lock().is_empty() && paper.sent.lock().is_empty());
    }

    #[tokio::test]
    async fn a_router_follows_connections_added_and_removed() {
        let (_paper, _prop, router) = prop_and_paper();
        let changes = router.changes();
        assert!(router.add(Fake::paper("paper-a") as _).is_err());
        assert!(router.remove("rithmic-apex").is_some());
        assert!(changes.has_changed().unwrap());
        let ids: Vec<AccountId> = router
            .accounts()
            .await
            .unwrap()
            .into_iter()
            .map(|a| a.id)
            .collect();
        assert_eq!(ids, [AccountId::new("paper-x"), AccountId::new("paper-y")]);
        assert!(matches!(
            router.summary(&AccountId::new("apex-1")).await,
            Err(BrokerError::NotFound(_))
        ));
        assert_eq!(router.healths().len(), 1);
    }
}
