use std::sync::Arc;
use std::time::Duration;

use serde_json::{Value, json};
use tessera_broker::paper::test_seeds;
use tessera_core::Timestamp;
use tessera_runtime::{Runtime, RuntimeConfig, RuntimeHandle};
use tessera_testkit::Fakes;
use tessera_testkit::ShiftedClock;

mod common;

use common::Client;

async fn start_with(data_dir: Option<std::path::PathBuf>) -> RuntimeHandle {
    let now = Timestamp::parse("2026-10-02T14:42:30-04:00").unwrap();
    let config = RuntimeConfig {
        clock: Arc::new(ShiftedClock::starting_at(now)),
        data_dir,
        paper_accounts: test_seeds(),
        ..RuntimeConfig::default()
    };
    Runtime::build(
        config,
        vec![
            Fakes {
                intraday_sessions: 2,
                tick: Some(Duration::from_millis(50)),
                ..Fakes::default()
            }
            .module(),
        ],
    )
    .await
    .unwrap()
    .spawn()
}

async fn subscribe(c: &mut Client, topic: &str, params: Value) -> String {
    let r = c
        .ok("subscribe", json!({ "topic": topic, "params": params }))
        .await;
    r["subscriptionId"].as_str().unwrap().to_owned()
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
async fn place_fill_position_and_flatten_over_the_socket() {
    let h = start_with(None).await;
    let mut c = Client::new(&h).await;

    let accounts = subscribe(&mut c, "accounts", json!({})).await;
    let main = c
        .event(&accounts, |p| p["data"]["account"]["id"] == "paper-main")
        .await;
    assert_eq!(main["seq"], 0, "a snapshot");
    assert_eq!(main["data"]["account"]["environment"], "paper");
    assert_eq!(main["data"]["summary"]["netLiq"]["amount"], 100_000);
    assert!(main["data"]["risk"].is_null());
    assert!(main["data"].get("limits").is_none());
    let eval = c
        .event(&accounts, |p| p["data"]["account"]["id"] == "eval-50k")
        .await;
    assert_eq!(eval["data"]["account"]["displayName"], "Eval 50K");
    assert_eq!(eval["data"]["account"]["environment"], "eval");
    assert_eq!(eval["data"]["summary"]["balance"]["amount"], 51_240);
    assert!(eval["data"]["risk"].is_null());
    assert!(eval["data"].get("limits").is_none());

    let orders = subscribe(&mut c, "orders", json!({ "accountId": "paper-main" })).await;
    let positions = subscribe(&mut c, "positions", json!({ "accountId": "paper-main" })).await;
    let fills = subscribe(&mut c, "fills", json!({ "accountId": "paper-main" })).await;

    let r = c
        .ok(
            "tools.invoke",
            json!({
                "name": "orders.submit",
                "input": buy_nq("paper-main", 2),
                "idempotencyKey": "click-1",
                "surface": { "armed": true, "holdConfirmed": false },
            }),
        )
        .await;
    assert_eq!(r["status"], "ok", "{r}");
    let entry = r["output"]["order"].clone();
    assert_eq!(entry["status"], "filled");
    assert_eq!(entry["environment"], "paper");
    assert_eq!(entry["request"]["instrument"], "NQZ6.CME");
    let price = entry["avgFillPrice"].as_f64().unwrap();

    let f = c.event(&fills, |p| p["seq"] != 0).await;
    assert_eq!(f["data"]["fill"]["orderId"], entry["id"]);
    assert_eq!(f["data"]["fill"]["qty"], 2);
    let p = c
        .event(&positions, |p| p["data"]["position"]["qty"] == 2)
        .await;
    assert_eq!(p["data"]["position"]["avgPrice"].as_f64().unwrap(), price);
    let stop = c
        .event(&orders, |p| {
            p["data"]["order"]["role"] == "stop_loss" && p["data"]["order"]["status"] == "working"
        })
        .await;
    assert_eq!(stop["data"]["order"]["request"]["stopPrice"], 20_600);
    assert_eq!(stop["data"]["order"]["request"]["qty"], 2);
    assert_eq!(stop["data"]["order"]["parentId"], entry["id"]);
    c.event(&accounts, |p| {
        p["seq"] != 0 && p["data"]["account"]["id"] == "paper-main"
    })
    .await;

    let r = c
        .ok(
            "tools.invoke",
            json!({ "name": "orders.flatten", "input": { "accountId": "paper-main" } }),
        )
        .await;
    assert_eq!(r["status"], "ok", "{r}");
    assert_eq!(r["output"]["flat"], true);
    assert_eq!(r["output"]["cancelled"].as_array().unwrap().len(), 2);
    assert_eq!(r["output"]["closing"][0]["status"], "filled");
    c.event(&positions, |p| p["data"]["position"]["qty"] == 0)
        .await;
    let cancelled = c
        .event(&orders, |p| {
            p["data"]["order"]["role"] == "take_profit"
                && p["data"]["order"]["status"] == "cancelled"
        })
        .await;
    assert_eq!(cancelled["data"]["order"]["reason"], "Cancelled.");

    let r = c
        .ok(
            "tools.invoke",
            json!({ "name": "portfolio.get_positions", "input": { "accountId": "paper-main" } }),
        )
        .await;
    assert_eq!(r["output"]["positions"], json!([]));
    let r = c
        .ok(
            "tools.invoke",
            json!({ "name": "portfolio.get_fills", "input": { "accountId": "paper-main" } }),
        )
        .await;
    let all = r["output"]["fills"].as_array().unwrap();
    assert_eq!(all.len(), 2);
    assert!(all[1]["realizedPnl"]["amount"].is_number());
    let r = c
        .ok(
            "tools.invoke",
            json!({ "name": "portfolio.get_accounts", "input": {} }),
        )
        .await;
    let main = &r["output"]["accounts"][0];
    assert_eq!(main["account"]["id"], "paper-main");
    assert_eq!(
        main["summary"]["realizedToday"]["amount"],
        all[1]["realizedPnl"]["amount"]
    );
    h.shutdown().await.unwrap();
}

fn cents(v: f64) -> f64 {
    (v * 100.0).round() / 100.0
}

#[tokio::test]
async fn a_paper_round_trip_pays_the_default_commission_in_its_fills_today_and_the_journal() {
    let h = start_with(None).await;
    let mut c = Client::new(&h).await;
    let r = c
        .ok(
            "tools.invoke",
            json!({
                "name": "orders.submit",
                "input": buy_nq("paper-main", 2),
                "idempotencyKey": "round-trip",
                "surface": { "armed": true, "holdConfirmed": false },
            }),
        )
        .await;
    assert_eq!(r["status"], "ok", "{r}");
    let entry = r["output"]["order"]["avgFillPrice"].as_f64().unwrap();
    let r = c
        .ok(
            "tools.invoke",
            json!({ "name": "orders.flatten", "input": { "accountId": "paper-main" } }),
        )
        .await;
    assert_eq!(r["output"]["closing"][0]["status"], "filled", "{r}");

    let r = c
        .ok(
            "tools.invoke",
            json!({ "name": "portfolio.get_fills", "input": { "accountId": "paper-main" } }),
        )
        .await;
    let fills = r["output"]["fills"].as_array().unwrap().clone();
    assert_eq!(fills.len(), 2);
    for f in &fills {
        assert_eq!(f["fee"]["amount"], 5.74, "2 NQ × $2.87 a side: {f}");
    }
    let realized = fills[1]["realizedPnl"]["amount"].as_f64().unwrap();
    let net = cents(realized - 11.48);

    let r = c
        .ok(
            "tools.invoke",
            json!({ "name": "portfolio.get_accounts", "input": {} }),
        )
        .await;
    let main = r["output"]["accounts"]
        .as_array()
        .unwrap()
        .iter()
        .find(|a| a["account"]["id"] == "paper-main")
        .unwrap()
        .clone();
    assert_eq!(main["summary"]["feesToday"]["amount"], 11.48);
    assert_eq!(main["summary"]["dayPnl"]["amount"], net, "{main}");
    assert_eq!(main["summary"]["balance"]["amount"], cents(100_000.0 + net));

    let trade = c
        .settle(
            "the journal closes the trade",
            |c| {
                Box::pin(async move {
                    let r = c
                        .ok(
                            "tools.invoke",
                            json!({ "name": "journal.list_trades", "input": {} }),
                        )
                        .await;
                    r["output"]["trades"]
                        .as_array()
                        .and_then(|t| t.iter().find(|t| t["status"] == "closed"))
                        .cloned()
                        .unwrap_or(Value::Null)
                })
            },
            |trade| !trade.is_null(),
        )
        .await;
    assert_eq!(trade["fees"], 11.48, "{trade}");
    assert_eq!(trade["netPnl"], net);
    let risk = cents((entry - 20_600.0) * 20.0 * 2.0);
    assert_eq!(
        trade["risk"], risk,
        "2 NQ from {entry} to the stop at 20,600"
    );
    assert_eq!(trade["rMultiple"], cents(net / risk));
    h.shutdown().await.unwrap();
}

#[tokio::test]
async fn eval_entries_need_the_hold_and_an_agent_never_sends() {
    let h = start_with(None).await;
    let mut c = Client::new(&h).await;
    let mut input = buy_nq("eval-50k", 1);
    input["bracket"]["stopLoss"] = json!(20630);
    let r = c
        .ok(
            "tools.invoke",
            json!({ "name": "orders.submit", "input": input,
                    "surface": { "armed": true, "holdConfirmed": false } }),
        )
        .await;
    assert_eq!(r["status"], "pending_approval", "{r}");
    let e = c
        .ok(
            "approvals.resolve",
            json!({ "approvalId": r["approval"]["approvalId"], "decision": "reject",
                    "previewHash": r["approval"]["previewHash"] }),
        )
        .await;
    assert_eq!(e["approval"]["status"], "rejected");
    let r = c
        .ok(
            "tools.invoke",
            json!({ "name": "orders.submit", "input": input,
                    "surface": { "armed": false, "holdConfirmed": true } }),
        )
        .await;
    assert_eq!(r["status"], "ok", "{r}");
    assert_eq!(r["output"]["order"]["environment"], "eval");
    h.shutdown().await.unwrap();
}

#[tokio::test]
async fn the_traders_limits_apply_at_once_and_only_the_user_sets_them() {
    let h = start_with(None).await;
    let mut c = Client::new(&h).await;
    let accounts = subscribe(&mut c, "accounts", json!({ "accountId": "paper-main" })).await;
    let r = c
        .ok(
            "tools.invoke",
            json!({ "name": "settings.set", "input": { "key": "risk.limits", "value": {
                "every": { "dailyLossLimit": 500, "maxRiskPerTrade": 250 } } } }),
        )
        .await;
    assert_eq!(r["status"], "ok", "{r}");
    let u = c
        .event(&accounts, |p| p["data"].get("limits").is_some())
        .await;
    assert_eq!(u["data"]["limits"]["dailyLossLimit"]["amount"], 500);
    assert_eq!(u["data"]["limits"]["dailyLossLeft"]["amount"], 500);
    assert_eq!(u["data"]["limits"]["maxRiskPerTrade"]["amount"], 250);
    assert_eq!(u["data"]["limits"]["locked"], false);

    let r = c
        .ok(
            "tools.invoke",
            json!({ "name": "orders.submit", "input": buy_nq("paper-main", 2),
                    "surface": { "armed": true, "holdConfirmed": false } }),
        )
        .await;
    assert_eq!(r["status"], "error", "{r}");
    let why = r["error"]["message"].as_str().unwrap();
    let risk: f64 = why
        .strip_prefix("Paper (Tessera Paper): This stop risks $")
        .and_then(|rest| rest.strip_suffix(": over your $250 a trade."))
        .and_then(|amount| amount.replace(',', "").parse().ok())
        .unwrap_or_else(|| panic!("{why}"));
    assert!(risk > 250.0, "{why}");

    let agent = Arc::clone(&h.state.invoker);
    let origin = tessera_core::Origin::Agent {
        session_id: tessera_core::ids::SessionId::new("S-limits"),
        provider: "codex".into(),
    };
    let read = agent
        .invoke(tessera_tools::InvokeRequest::new(
            "risk.get_limits",
            json!({ "accountId": "paper-main" }),
            origin.clone(),
        ))
        .await;
    assert!(read.ok, "{read:?}");
    let out = read.output.unwrap();
    assert_eq!(out["setting"]["every"]["dailyLossLimit"], 500.0);
    assert_eq!(out["accounts"][0]["status"]["dailyLossLeft"]["amount"], 500);
    let loosen = agent
        .invoke(tessera_tools::InvokeRequest::new(
            "settings.set",
            json!({ "key": "risk.limits", "value": {} }),
            origin,
        ))
        .await;
    assert!(!loosen.ok);
    assert!(loosen.approval.is_none(), "not even proposed");

    let r = c
        .ok(
            "tools.invoke",
            json!({ "name": "settings.set", "input": { "key": "risk.limits", "value": {} } }),
        )
        .await;
    assert_eq!(r["status"], "ok", "{r}");
    c.event(&accounts, |p| p["data"].get("limits").is_none())
        .await;
    let r = c
        .ok(
            "tools.invoke",
            json!({ "name": "orders.submit", "input": buy_nq("paper-main", 2),
                    "surface": { "armed": true, "holdConfirmed": false } }),
        )
        .await;
    assert_eq!(r["status"], "ok", "{r}");
    h.shutdown().await.unwrap();
}

#[tokio::test]
async fn an_order_draft_goes_stale_by_ticks() {
    let h = start_with(None).await;
    let mut c = Client::new(&h).await;
    let r = c
        .ok(
            "tools.invoke",
            json!({ "name": "settings.set",
                    "input": { "key": "approvals.staleAfterTicks", "value": 3 } }),
        )
        .await;
    assert_eq!(r["status"], "ok", "{r}");
    let approvals = subscribe(&mut c, "approvals", json!({})).await;
    let drafts = subscribe(&mut c, "drafts", json!({ "accountId": "paper-main" })).await;
    let r = c
        .ok(
            "tools.invoke",
            json!({ "name": "orders.create_draft", "input": buy_nq("paper-main", 1),
                    "surface": { "armed": true, "holdConfirmed": true } }),
        )
        .await;
    assert_eq!(r["status"], "pending_approval", "{r}");
    let id = r["approval"]["approvalId"].clone();
    let live = c.event(&drafts, |p| p["data"]["status"] == "live").await;
    assert_eq!(live["data"]["environment"], "paper");
    assert_eq!(live["data"]["instrument"], "NQZ6.CME");
    let stale = c
        .event(&approvals, |p| {
            p["data"]["type"] == "stale" && p["data"]["approval"]["id"] == id
        })
        .await;
    assert!(stale["data"]["approval"]["ticksSeen"].as_u64().unwrap() >= 3);
    let d = c.event(&drafts, |p| p["data"]["status"] == "stale").await;
    assert_eq!(d["data"]["live"], false);
    let e = c
        .call(
            "approvals.resolve",
            json!({ "approvalId": id, "decision": "approve",
                    "previewHash": r["approval"]["previewHash"] }),
        )
        .await;
    assert!(
        e.get("error").is_some(),
        "a stale draft cannot be approved: {e}"
    );
    h.shutdown().await.unwrap();
}

#[tokio::test]
async fn a_restart_restores_the_broker() {
    let dir = tempfile::tempdir().unwrap();
    let h = start_with(Some(dir.path().to_path_buf())).await;
    let mut c = Client::new(&h).await;
    let r = c
        .ok(
            "tools.invoke",
            json!({ "name": "orders.submit", "input": buy_nq("paper-main", 2),
                    "surface": { "armed": true, "holdConfirmed": false } }),
        )
        .await;
    assert_eq!(r["status"], "ok", "{r}");
    let price = r["output"]["order"]["avgFillPrice"].clone();
    drop(c);
    h.shutdown().await.unwrap();

    let h = start_with(Some(dir.path().to_path_buf())).await;
    let mut c = Client::new(&h).await;
    let positions = subscribe(&mut c, "positions", json!({})).await;
    let p = c.event(&positions, |p| p["seq"] == 0).await;
    assert_eq!(p["data"]["position"]["accountId"], "paper-main");
    assert_eq!(p["data"]["position"]["qty"], 2);
    assert_eq!(p["data"]["position"]["avgPrice"], price);
    let r = c
        .ok(
            "tools.invoke",
            json!({ "name": "portfolio.get_orders",
                    "input": { "accountId": "paper-main", "openOnly": true } }),
        )
        .await;
    let open = r["output"]["orders"].as_array().unwrap();
    assert_eq!(
        open.len(),
        2,
        "the stop and the target still work: {open:?}"
    );
    h.shutdown().await.unwrap();
}

#[tokio::test]
async fn a_paper_order_past_its_deadline_is_not_sent() {
    let h = start_with(None).await;
    let mut c = Client::new(&h).await;
    let before = c
        .ok(
            "tools.invoke",
            json!({ "name": "portfolio.get_orders", "input": { "accountId": "paper-main" } }),
        )
        .await;
    let n = before["output"]["orders"].as_array().unwrap().len();
    let r = c
        .ok(
            "tools.invoke",
            json!({
                "name": "orders.submit",
                "input": buy_nq("paper-main", 1),
                "idempotencyKey": "late-paper",
                "deadline": Timestamp::now().0 - 1,
                "surface": { "armed": true, "holdConfirmed": false },
            }),
        )
        .await;
    assert_eq!(r["status"], "error", "{r}");
    assert_eq!(r["error"]["details"]["outcome"], "late");
    assert_eq!(r["error"]["details"]["sent"], false);
    let after = c
        .ok(
            "tools.invoke",
            json!({ "name": "portfolio.get_orders", "input": { "accountId": "paper-main" } }),
        )
        .await;
    assert_eq!(after["output"]["orders"].as_array().unwrap().len(), n);
    h.shutdown().await.unwrap();
}

#[tokio::test]
async fn a_paper_order_within_its_deadline_goes_once_and_a_repeat_key_is_deduped() {
    let h = start_with(None).await;
    let mut c = Client::new(&h).await;
    let params = json!({
        "name": "orders.submit",
        "input": buy_nq("paper-main", 1),
        "idempotencyKey": "fresh-paper",
        "deadline": Timestamp::now().0 + 20_000_000_000i64,
        "surface": { "armed": true, "holdConfirmed": false },
    });
    let r = c.ok("tools.invoke", params.clone()).await;
    assert_eq!(r["status"], "ok", "{r}");
    assert_eq!(r["output"]["order"]["status"], "filled");
    let again = c.ok("tools.invoke", params).await;
    assert_eq!(again["status"], "ok", "{again}");
    assert_eq!(again["deduped"], true);
    assert_eq!(again["output"]["order"]["id"], r["output"]["order"]["id"]);
    h.shutdown().await.unwrap();
}

#[tokio::test]
async fn flatten_past_its_deadline_is_not_sent() {
    let h = start_with(None).await;
    let mut c = Client::new(&h).await;
    let r = c
        .ok(
            "tools.invoke",
            json!({
                "name": "orders.submit",
                "input": buy_nq("paper-main", 1),
                "deadline": Timestamp::now().0 + 20_000_000_000i64,
                "surface": { "armed": true, "holdConfirmed": false },
            }),
        )
        .await;
    assert_eq!(r["status"], "ok", "{r}");
    let flat = c
        .ok(
            "tools.invoke",
            json!({
                "name": "orders.flatten",
                "input": { "accountId": "paper-main" },
                "deadline": Timestamp::now().0 - 1,
            }),
        )
        .await;
    assert_eq!(flat["status"], "error", "{flat}");
    assert_eq!(flat["error"]["details"]["outcome"], "late");
    let pos = c
        .ok(
            "tools.invoke",
            json!({ "name": "portfolio.get_positions", "input": { "accountId": "paper-main" } }),
        )
        .await;
    assert_eq!(pos["output"]["positions"][0]["qty"], 1);
    h.shutdown().await.unwrap();
}

#[tokio::test]
async fn an_approved_paper_draft_past_its_deadline_is_not_sent() {
    let h = start_with(None).await;
    let mut c = Client::new(&h).await;
    let r = c
        .ok(
            "tools.invoke",
            json!({
                "name": "orders.create_draft",
                "input": buy_nq("paper-main", 1),
                "surface": { "armed": true, "holdConfirmed": true },
            }),
        )
        .await;
    assert_eq!(r["status"], "pending_approval", "{r}");
    let e = c
        .call(
            "approvals.resolve",
            json!({
                "approvalId": r["approval"]["approvalId"],
                "decision": "approve",
                "previewHash": r["approval"]["previewHash"],
                "deadline": Timestamp::now().0 - 1,
                "idempotencyKey": "draft-late",
            }),
        )
        .await;
    assert!(e.get("error").is_some(), "{e}");
    assert!(
        e["error"]["message"].as_str().unwrap().contains("Too late"),
        "{e}"
    );
    let orders = c
        .ok(
            "tools.invoke",
            json!({ "name": "portfolio.get_orders", "input": { "accountId": "paper-main" } }),
        )
        .await;
    assert_eq!(orders["output"]["orders"], json!([]));
    h.shutdown().await.unwrap();
}
