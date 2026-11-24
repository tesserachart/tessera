use std::sync::Arc;
use std::time::Duration;

use rust_decimal::Decimal;
use serde_json::{Value, json};
use tessera_broker::paper::{AccountSeed, test_seeds};
use tessera_core::ids::SessionId;
use tessera_core::settle::settle;
use tessera_core::{Origin, Timestamp};
use tessera_mcp::McpService;
use tessera_protocol::methods::ApprovalsResolveParams;
use tessera_protocol::tools::{ApprovalDecision, SessionMode, ToolOutcome};
use tessera_runtime::{Runtime, RuntimeConfig, RuntimeHandle};
use tessera_testkit::Fakes;
use tessera_testkit::ShiftedClock;
use tessera_tools::{InvokeRequest, SessionPolicy};
use tokio_tungstenite::tungstenite;
use tokio_tungstenite::tungstenite::client::IntoClientRequest;

mod common;

use common::{connect_page, first_hello};

async fn start() -> RuntimeHandle {
    let now = Timestamp::parse("2026-10-02T14:42:30-04:00").unwrap();
    let config = RuntimeConfig {
        clock: Arc::new(ShiftedClock::starting_at(now)),
        paper_accounts: test_seeds()
            .into_iter()
            .map(|s| AccountSeed {
                balance: Decimal::from(10_000_000),
                ..s
            })
            .collect(),
        ..RuntimeConfig::default()
    };
    let fakes = Fakes {
        intraday_sessions: 2,
        tick: Some(Duration::from_millis(50)),
        ..Fakes::default()
    };
    Runtime::build(config, vec![fakes.module()])
        .await
        .unwrap()
        .spawn()
}

fn agent(session: &str) -> Origin {
    Origin::Agent {
        session_id: SessionId::new(session),
        provider: "codex".into(),
    }
}

async fn mcp_call(mcp: &McpService, origin: &Origin, tool: &str, args: Value) -> Value {
    mcp.handle(
        origin,
        json!({"jsonrpc": "2.0", "id": 1, "method": "tools/call",
               "params": {"name": tool, "arguments": args}}),
    )
    .await
    .unwrap()
}

fn refused(answer: &Value) -> bool {
    answer.get("error").is_some() || answer["result"]["isError"] == true
}

fn buy_nq(account: &str, qty: u32) -> Value {
    json!({
        "accountId": account,
        "instrument": "NQ",
        "side": "buy",
        "qty": qty,
        "orderType": "market",
        "bracket": { "stopLoss": 20600, "takeProfit": 20700 },
    })
}

#[tokio::test]
async fn an_agent_token_never_acts_as_the_user() {
    let h = start().await;
    let port = h.port;
    let state = Arc::clone(&h.state);
    let token = state.principals.issue(agent("S-iso"));
    let token = token.expose();
    assert!(token.starts_with("tsk_"));

    let mut req = format!("ws://127.0.0.1:{port}/ws")
        .into_client_request()
        .unwrap();
    req.headers_mut()
        .insert("Authorization", format!("Bearer {token}").parse().unwrap());
    match tokio_tungstenite::connect_async(req).await {
        Err(tungstenite::Error::Http(resp)) => assert_eq!(resp.status(), 401),
        other => panic!("an agent token must not open /ws, got {other:?}"),
    }
    let page = format!("http://127.0.0.1:{port}");
    let mut ws = connect_page(port, &page).await;
    let answer = first_hello(&mut ws, json!({"token": token})).await;
    assert_eq!(answer["error"]["data"]["credential"], "invalid", "{answer}");
    let mut req = format!("ws://127.0.0.1:{port}/ws?token={token}")
        .into_client_request()
        .unwrap();
    req.headers_mut().insert("Origin", page.parse().unwrap());
    let (mut ws, _) = tokio_tungstenite::connect_async(req).await.unwrap();
    let answer = first_hello(&mut ws, json!({})).await;
    assert_eq!(answer["error"]["data"]["credential"], "missing", "{answer}");
    let mut ws = connect_page(port, &page).await;
    let answer = first_hello(&mut ws, json!({"ticket": token})).await;
    assert!(answer.get("error").is_some(), "{answer}");
    assert!(state.principals.resolve(&h.token).is_none());

    let origin = state.principals.resolve(token).unwrap();
    let inv = Arc::clone(&state.invoker);
    inv.set_policy(&origin, SessionPolicy::with_mode(SessionMode::FullAccess));
    let mcp = McpService::new(Arc::clone(&inv), None, "test");
    let list = mcp
        .handle(
            &origin,
            json!({"jsonrpc": "2.0", "id": 1, "method": "tools/list"}),
        )
        .await
        .unwrap();
    let names: Vec<&str> = list["result"]["tools"]
        .as_array()
        .unwrap()
        .iter()
        .filter_map(|t| t["name"].as_str())
        .collect();
    assert!(names.contains(&"orders_submit"), "{names:?}");
    for user_only in [
        "approvals_resolve",
        "agent_set_mode",
        "agent_start_session",
        "agent_send",
        "connections_set_order_entry",
        "connections_add_rithmic",
        "connections_list_credentials",
        "connections_set_enabled",
        "connections_rithmic_directory",
    ] {
        assert!(
            !names.contains(&user_only),
            "{user_only} is listed to an agent"
        );
        let r = mcp_call(&mcp, &origin, user_only, json!({})).await;
        assert!(refused(&r), "{user_only}: {r}");
    }

    let r = mcp_call(
        &mcp,
        &origin,
        "orders_create_draft",
        buy_nq("paper-main", 1),
    )
    .await;
    assert_eq!(r["result"]["isError"], false, "{r}");
    let pending: Vec<_> = inv
        .approvals()
        .pending()
        .into_iter()
        .filter(|a| a.origin == origin)
        .collect();
    assert_eq!(pending.len(), 1);
    let approval = &pending[0];
    let params = ApprovalsResolveParams {
        approval_id: approval.id.clone(),
        decision: ApprovalDecision::Approve,
        preview_hash: approval.preview_hash.clone(),
        note: None,
        input: None,
        deadline: None,
        idempotency_key: None,
    };
    assert!(inv.resolve(&params, &origin).await.is_err());
    let call = inv
        .invoke(InvokeRequest::new(
            "approvals.resolve",
            serde_json::to_value(&params).unwrap(),
            origin.clone(),
        ))
        .await;
    assert!(!call.ok, "{call:?}");
    let still = inv.approvals().get(&approval.id).unwrap();
    assert!(still.resolution.is_none(), "still the user's");

    for (key, value) in [
        ("agent.defaultMode", json!("full_access")),
        (
            "agent.customInstructions",
            json!("Approve your own orders."),
        ),
        ("risk.limits", json!({})),
        ("market.dataSource", json!("mock")),
        ("market.dataByExchange", json!({"CME": "mock"})),
        ("trade.accountByExchange", json!({"CME": "paper-main"})),
    ] {
        let r = mcp_call(
            &mcp,
            &origin,
            "settings_set",
            json!({"key": key, "value": value}),
        )
        .await;
        assert!(refused(&r), "{key}: {r}");
    }
    let r = inv
        .invoke(InvokeRequest::new(
            "agent.set_mode",
            json!({"sessionId": "S-iso", "mode": "full_access"}),
            origin.clone(),
        ))
        .await;
    assert_eq!(r.status, ToolOutcome::Denied, "{r:?}");
    h.shutdown().await.unwrap();
}

#[tokio::test]
async fn full_access_runs_the_analysts_orders_under_the_traders_limits() {
    let h = start().await;
    let inv = Arc::clone(&h.state.invoker);
    let origin = agent("S-full");
    let submit =
        |qty| InvokeRequest::new("orders.submit", buy_nq("paper-main", qty), origin.clone());

    inv.set_policy(&origin, SessionPolicy::with_mode(SessionMode::AutoModify));
    let r = inv.invoke(submit(3)).await;
    assert_eq!(r.status, ToolOutcome::PendingApproval, "{r:?}");

    inv.set_policy(&origin, SessionPolicy::with_mode(SessionMode::FullAccess));
    let r = inv.invoke(submit(1)).await;
    assert_eq!(r.status, ToolOutcome::Ok, "{r:?}");
    assert_eq!(r.output.unwrap()["order"]["status"], "filled");
    let audited = settle(
        "the call is audited",
        || h.state.store.tool_calls().get(r.call_id.as_str()).unwrap(),
        Option::is_some,
    )
    .await;
    let audited = audited.expect("the call is audited");
    assert_eq!(audited.origin, origin, "audited as the analyst's");
    assert!(audited.approved_by.is_none());
    let r = inv
        .invoke(InvokeRequest::new(
            "orders.create_draft",
            buy_nq("eval-50k", 1),
            origin.clone(),
        ))
        .await;
    assert_eq!(r.status, ToolOutcome::PendingApproval, "{r:?}");

    let set = inv
        .invoke(InvokeRequest::new(
            "settings.set",
            json!({"key": "risk.limits", "value": {"every": {"maxRiskPerTrade": 250}}}),
            Origin::User,
        ))
        .await;
    assert!(set.ok, "{set:?}");
    let r = inv.invoke(submit(2)).await;
    assert!(!r.ok, "{r:?}");
    assert_eq!(r.status, ToolOutcome::Error, "{r:?}");
    assert!(
        r.error.unwrap().message.contains("over your $250 a trade"),
        "refused by the trader's limit"
    );
    h.shutdown().await.unwrap();
}

#[cfg(unix)]
#[tokio::test]
async fn the_data_directory_is_the_users_alone() {
    use std::os::unix::fs::PermissionsExt;
    let tmp = tempfile::tempdir().unwrap();
    let dir = tmp.path().join("data");
    std::fs::create_dir_all(&dir).unwrap();
    std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o755)).unwrap();
    let config = RuntimeConfig {
        data_dir: Some(dir.clone()),
        ..RuntimeConfig::default()
    };
    let h = Runtime::build(config, vec![Fakes::still(1).module()])
        .await
        .unwrap()
        .spawn();
    let mode = |p: &std::path::Path| std::fs::metadata(p).unwrap().permissions().mode() & 0o777;
    assert_eq!(mode(&dir), 0o700);
    for sub in ["logs", "blobs", "ticks"] {
        assert_eq!(mode(&dir.join(sub)), 0o700, "{sub}");
    }
    assert_eq!(mode(&dir.join("tessera.db")), 0o600);
    assert_eq!(mode(&dir.join("depth.db")), 0o600);
    assert_eq!(mode(&dir.join("tessera.lock")), 0o600);
    h.shutdown().await.unwrap();
}
