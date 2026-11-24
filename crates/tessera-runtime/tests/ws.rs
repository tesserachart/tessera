use std::sync::Arc;
use std::time::Duration;

use async_trait::async_trait;
use futures::SinkExt;
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use tessera_core::accounts::Environment;
use tessera_core::settle::settle;
use tessera_core::{InstrumentId, Timestamp};
use tessera_host::{
    EventBus, KeyFilter, ModuleHost, RuntimeModule, Subscribed, TopicHandler, TopicKey, TopicSizing,
};
use tessera_protocol::RpcError;
use tessera_protocol::tools::RiskTier;
use tessera_runtime::{ModuleFactory, Runtime, RuntimeConfig, RuntimeHandle, ToolsModule};
use tessera_testkit::Fakes;
use tessera_testkit::ShiftedClock;
use tessera_tools::{ActionTarget, Tool, ToolCtx, ToolError, ToolMeta};
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::tungstenite::{self, Message};

mod common;

use common::{Client, closed, connect_page, first, first_hello, http};

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
struct SubmitInput {
    account: String,
    symbol: String,
    qty: u32,
}

struct TestSubmit;

#[async_trait]
impl Tool for TestSubmit {
    type Input = SubmitInput;
    type Output = Value;
    fn meta(&self) -> ToolMeta {
        ToolMeta::new("test.submit", "Submit (test)", RiskTier::Financial)
    }
    async fn call(&self, ctx: &ToolCtx, i: SubmitInput) -> Result<Value, ToolError> {
        Ok(json!({ "submitted": i.qty, "approvedBy": ctx.approved_by }))
    }
    async fn preview(&self, _ctx: &ToolCtx, i: &SubmitInput) -> Result<Value, ToolError> {
        Ok(json!({ "restatement": format!("BUY {} {} LMT", i.qty, i.symbol) }))
    }
    async fn target(&self, i: &SubmitInput) -> Option<ActionTarget> {
        Some(ActionTarget {
            account: i.account.clone(),
            instrument: InstrumentId::new(&i.symbol).ok(),
            environment: Some(Environment::Paper),
            exit: false,
        })
    }
}

async fn start() -> RuntimeHandle {
    let now = Timestamp::parse("2026-10-02T14:42:30-04:00").unwrap();
    let config = RuntimeConfig {
        clock: Arc::new(ShiftedClock::starting_at(now)),
        review_origins: vec!["https://review.example.test".into()],
        ..RuntimeConfig::default()
    };
    let fakes = Fakes {
        intraday_sessions: 3,
        tick: Some(Duration::from_millis(50)),
        ..Fakes::default()
    };
    let rt = Runtime::build(
        config,
        vec![
            fakes.module(),
            ToolsModule::new("test", |r| r.register(TestSubmit)).factory(),
        ],
    )
    .await
    .unwrap();
    let line: Value = serde_json::from_str(&rt.ready_line()).unwrap();
    assert_eq!(line["event"], "ready");
    assert_eq!(line["port"], rt.port());
    let token = line["token"].as_str().unwrap();
    assert!(token.starts_with("tss_") && token.len() == 68, "{token}");
    let h = rt.spawn();
    without_watchlist_recording(&h).await;
    h
}

async fn without_watchlist_recording(h: &RuntimeHandle) {
    let r = h
        .state
        .invoker
        .invoke(tessera_tools::InvokeRequest::new(
            "settings.set",
            json!({"key": "market.recordWatchlists", "value": false}),
            tessera_core::Origin::User,
        ))
        .await;
    assert!(r.ok, "{r:?}");
    settle(
        "the watchlists stop recording",
        || h.state.market.hub().pump_count(),
        |&pumps| pumps == 0,
    )
    .await;
}

#[tokio::test]
async fn hello_and_tools_list() {
    let h = start().await;
    let mut c = Client::new(&h).await;
    let hello = c
        .ok(
            "session.hello",
            json!({"client": {"name": "test", "platform": "browser"}}),
        )
        .await;
    assert_eq!(hello["protocolVersion"], 1);
    assert_eq!(
        hello["environment"], "paper",
        "paper-main, the account surfaces open on"
    );
    assert_eq!(hello["defaultLayoutId"], "default");
    let topics = hello["capabilities"]["topics"].as_array().unwrap();
    for t in ["orders", "positions", "accounts", "fills", "drafts"] {
        assert!(topics.contains(&json!(t)), "{t}");
    }
    assert_eq!(hello["capabilities"]["market"][0]["providerId"], "mock");
    let topics = hello["capabilities"]["topics"].as_array().unwrap();
    assert!(topics.contains(&json!("market.quotes")));
    assert!(topics.contains(&json!("intel.levels")));
    assert!(topics.contains(&json!("market.depth")));
    assert!(topics.contains(&json!("market.footprint")));
    let intel = &hello["capabilities"]["intel"][0];
    assert_eq!(intel["providerId"], "mock-gamma");
    assert_eq!(intel["capabilities"]["vendor"], "Mock");

    let tools = c.ok("tools.list", json!({})).await;
    let names: Vec<&str> = tools
        .as_array()
        .unwrap()
        .iter()
        .map(|t| t["name"].as_str().unwrap())
        .collect();
    for want in [
        "market.get_quote",
        "market.get_candles",
        "market.search_instruments",
        "market.list_instruments",
        "market.get_contract_spec",
        "market.get_sessions",
        "market.get_print_bars",
        "watchlists.list",
        "watchlists.create",
        "watchlists.rename",
        "watchlists.delete",
        "watchlists.add",
        "watchlists.remove",
        "watchlists.move",
        "intel.get_levels",
        "intel.get_conversion",
        "intel.list_providers",
        "layout.get",
        "layout.save",
        "layout.list",
        "layout.delete",
        "workspace.open_tile",
        "settings.get",
        "settings.set",
        "chart.get_state",
        "chart.set_symbol",
        "chart.set_timeframe",
        "chart.set_chart_type",
        "chart.set_hours",
        "chart.add_layer",
        "chart.remove_layer",
        "chart.list_templates",
        "chart.save_template",
        "chart.apply_template",
        "chart.annotate",
        "chart.clear_annotations",
        "orders.preview",
        "orders.submit",
        "orders.create_draft",
        "orders.modify",
        "orders.cancel",
        "orders.cancel_all",
        "orders.flatten",
        "orders.merge_brackets",
        "orders.breakeven",
        "orders.reverse",
        "copy.list",
        "copy.disable",
        "copy.status",
        "copy.flatten",
        "portfolio.get_accounts",
        "portfolio.get_positions",
        "portfolio.get_orders",
        "portfolio.get_fills",
        "portfolio.get_risk_status",
        "test.submit",
    ] {
        assert!(names.contains(&want), "{want} missing from {names:?}");
    }
    assert!(
        !names.contains(&"chart.report_viewport"),
        "hidden by default"
    );
    let all = c.ok("tools.list", json!({"includeHidden": true})).await;
    assert!(
        all.as_array()
            .unwrap()
            .iter()
            .any(|t| t["name"] == "chart.report_viewport")
    );
    for user_only in [
        "copy.create",
        "copy.update",
        "copy.enable",
        "copy.delete",
        "copy.resync",
    ] {
        assert!(!names.contains(&user_only), "{user_only} is the user's");
    }
    let candles = tools
        .as_array()
        .unwrap()
        .iter()
        .find(|t| t["name"] == "market.get_candles")
        .unwrap();
    assert_eq!(candles["risk"], "read");
    assert_eq!(candles["mcpName"], "market_get_candles");
    assert_eq!(candles["inputSchema"]["type"], "object");
    let market = c.ok("tools.list", json!({"category": "market"})).await;
    assert_eq!(market.as_array().unwrap().len(), 28);
    let intel = c.ok("tools.list", json!({"category": "intel"})).await;
    assert_eq!(intel.as_array().unwrap().len(), 14);
    let writes = [
        "intel.draft_source",
        "intel.discard_source_draft",
        "intel.import_level_history",
        "intel.undo_level_import",
        "intel.backfill_level_history",
    ];
    for t in intel.as_array().unwrap() {
        let modify = writes.contains(&t["name"].as_str().unwrap());
        assert_eq!(
            t["risk"],
            if modify { "modify" } else { "read" },
            "{}",
            t["name"]
        );
    }
    h.shutdown().await.unwrap();
}

async fn heard_until_answered(c: &mut Client, method: &str, params: Value) -> Vec<Value> {
    let id = c.next;
    c.next += 1;
    let req = json!({"jsonrpc": "2.0", "id": id, "method": method, "params": params});
    c.ws.send(Message::text(req.to_string())).await.unwrap();
    let mut heard = Vec::new();
    loop {
        let v = c.recv().await;
        if v["id"] == json!(id) {
            return heard;
        }
        heard.push(v);
    }
}

async fn next_pulse(c: &mut Client) -> Value {
    loop {
        let v = c.recv().await;
        if v["method"] == "session.pulse" {
            return v["params"].clone();
        }
    }
}

#[tokio::test]
async fn a_connection_that_asks_for_the_pulse_hears_it_every_second_and_others_never() {
    let h = start().await;
    let mut quiet = Client::new(&h).await;
    let unasked = quiet
        .ok("session.hello", json!({"client": {"name": "test"}}))
        .await;
    assert!(unasked.get("pulseMs").is_none(), "{unasked}");
    let mut asked = Client::new(&h).await;
    let hello = asked
        .ok(
            "session.hello",
            json!({"client": {"name": "test"}, "pulse": true}),
        )
        .await;

    let first = next_pulse(&mut asked).await;
    let second = next_pulse(&mut asked).await;
    assert_eq!(first["everyMs"], 1000);
    let (a, b) = (
        first["ms"].as_u64().unwrap(),
        second["ms"].as_u64().unwrap(),
    );
    let at_hello = hello["pulseMs"]
        .as_u64()
        .expect("the hello answer carries the pulse clock");
    assert!(
        a >= at_hello + 1000 && b >= at_hello + 2000 && b > a,
        "hello at {at_hello} ms, then beats on its one-second grid at {a} ms and {b} ms"
    );

    let heard = heard_until_answered(&mut quiet, "tools.list", json!({})).await;
    assert!(
        heard.iter().all(|v| v["method"] != "session.pulse"),
        "two beats after the asking page's hello, the quiet page heard {heard:?}"
    );
    h.shutdown().await.unwrap();
}

#[tokio::test]
async fn market_tools_over_rpc() {
    let h = start().await;
    let mut c = Client::new(&h).await;
    let r = c
        .ok(
            "tools.invoke",
            json!({"name": "market.get_quote", "input": {"instrument": "qqq"}}),
        )
        .await;
    assert_eq!(r["ok"], true, "{r}");
    assert_eq!(r["status"], "ok");
    assert_eq!(r["output"]["instrument"], "QQQ");
    assert!(r["output"]["last"].as_f64().unwrap() > 400.0);
    assert!(r["callId"].as_str().unwrap().starts_with("call_"));

    let r = c
        .ok(
            "tools.invoke",
            json!({"name": "market.get_candles", "input": {"instrument": "NQ", "tf": "5m", "limit": 10}}),
        )
        .await;
    assert_eq!(r["ok"], true, "{r}");
    assert_eq!(r["output"]["instrument"], "NQZ6.CME");
    assert_eq!(
        r["output"]["columns"],
        json!(["t", "o", "h", "l", "c", "v", "bv"])
    );
    let bars = r["output"]["bars"].as_array().unwrap();
    assert_eq!(bars.len(), 10);
    let bar = bars[0].as_array().unwrap();
    assert_eq!(bar.len(), 7);
    assert!(bar[6].as_f64().unwrap() <= bar[5].as_f64().unwrap());

    let r = c
        .ok(
            "tools.invoke",
            json!({"name": "market.search_instruments", "input": {"query": "es"}}),
        )
        .await;
    assert_eq!(r["output"]["results"][0]["id"], "ESZ6.CME");
    let r = c
        .ok(
            "tools.invoke",
            json!({"name": "market.list_instruments", "input": {"assetClass": "future", "limit": 3}}),
        )
        .await;
    let listed = &r["output"]["connections"][0];
    assert_eq!(listed["id"], "mock", "{r}");
    assert_eq!(listed["feedsDesk"], true);
    assert_eq!(listed["error"], Value::Null);
    let instruments = listed["instruments"].as_array().unwrap();
    assert_eq!(instruments.len(), 3);
    assert!(instruments.iter().all(|i| i["assetClass"] == "future"));
    let r = c
        .ok(
            "tools.invoke",
            json!({"name": "market.list_instruments", "input": {"connection": "nope"}}),
        )
        .await;
    assert_eq!(r["error"]["code"], "not_found");
    assert!(r["error"]["message"].as_str().unwrap().contains("mock"));
    let r = c
        .ok(
            "tools.invoke",
            json!({"name": "market.get_contract_spec", "input": {"instrument": "MNQ"}}),
        )
        .await;
    assert_eq!(r["output"]["spec"]["tickValue"]["amount"], 0.5);

    let r = c
        .ok("tools.invoke", json!({"name": "nope.tool", "input": {}}))
        .await;
    assert_eq!(r["ok"], false);
    assert_eq!(r["error"]["code"], "unknown_tool");
    let r = c
        .ok(
            "tools.invoke",
            json!({"name": "market.get_quote", "input": {"instrument": "XYZ"}}),
        )
        .await;
    assert_eq!(r["error"]["code"], "not_found");
    let r = c
        .ok(
            "tools.invoke",
            json!({"name": "market.get_candles", "input": {"instrument": "QQQ"}}),
        )
        .await;
    assert_eq!(r["error"]["code"], "invalid_input", "tf is required");

    let e = c.call("tools.invoke", json!({"input": {}})).await;
    assert_eq!(e["error"]["code"], -32602);
    let e = c.call("nope", json!({})).await;
    assert_eq!(e["error"]["code"], -32601);
    h.shutdown().await.unwrap();
}

#[tokio::test]
async fn subscriptions_stream_quotes_bars_and_tool_calls() {
    let h = start().await;
    let mut c = Client::new(&h).await;
    let sub = c
        .ok(
            "subscribe",
            json!({"topic": "market.quotes", "params": {"instruments": ["QQQ", "NQ"]}}),
        )
        .await;
    let qs = sub["subscriptionId"].as_str().unwrap().to_owned();
    assert_eq!(sub["topic"], "market.quotes");
    let snap = c.event(&qs, |p| p["seq"] == 0).await;
    assert!(["QQQ", "NQZ6.CME"].contains(&snap["data"]["instrument"].as_str().unwrap()));
    let live = c.event(&qs, |p| p["seq"].as_u64().unwrap() > 0).await;
    assert!(live["data"]["bid"].as_f64().is_some());

    let bars = c
        .ok(
            "subscribe",
            json!({"topic": "market.bars", "params": {"instrument": "QQQ", "tf": "1m"}}),
        )
        .await;
    let bs = bars["subscriptionId"].as_str().unwrap().to_owned();
    let bar = c.event(&bs, |_| true).await;
    assert_eq!(bar["data"]["instrument"], "QQQ");
    assert_eq!(bar["data"]["tf"], "1m");
    assert_eq!(bar["data"]["bar"].as_array().unwrap().len(), 7, "with bv");
    assert_eq!(h.state.market.hub().pump_count(), 3);

    let calls = c
        .ok("subscribe", json!({"topic": "tool.calls", "params": {}}))
        .await;
    let cs = calls["subscriptionId"].as_str().unwrap().to_owned();
    let r = c
        .ok("tools.invoke", json!({"name": "layout.get", "input": {}}))
        .await;
    let call_id = r["callId"].clone();
    let started = c
        .event(&cs, |p| {
            p["data"]["phase"] == "started" && p["data"]["call"]["callId"] == call_id
        })
        .await;
    assert_eq!(started["data"]["call"]["origin"]["kind"], "user");
    let finished = c
        .event(&cs, |p| {
            p["data"]["phase"] == "finished" && p["data"]["call"]["callId"] == call_id
        })
        .await;
    assert_eq!(finished["data"]["call"]["status"], "ok");
    assert!(finished["seq"].as_u64().unwrap() > started["seq"].as_u64().unwrap());

    let u = c.ok("unsubscribe", json!({"subscriptionId": qs})).await;
    assert_eq!(u["removed"], true);
    let u = c.ok("unsubscribe", json!({"subscriptionId": qs})).await;
    assert_eq!(u["removed"], false);
    assert_eq!(h.state.market.hub().pump_count(), 1);

    let e = c
        .call(
            "subscribe",
            json!({"topic": "market.depth", "params": {"instrument": "NDX"}}),
        )
        .await;
    assert_eq!(e["error"]["code"], -32014, "an index has no book");
    let e = c.call("subscribe", json!({"topic": "nope"})).await;
    assert_eq!(e["error"]["code"], -32003);
    let e = c
        .call(
            "subscribe",
            json!({"topic": "market.quotes", "params": {"instruments": ["XYZ"]}}),
        )
        .await;
    assert_eq!(e["error"]["code"], -32602);

    settle(
        "the tool call is stored",
        || h.state.store.tool_calls().count().unwrap(),
        |&stored| stored >= 1,
    )
    .await;
    drop(c);
    settle(
        "closing the socket releases pumps",
        || h.state.market.hub().pump_count(),
        |&pumps| pumps == 0,
    )
    .await;
    h.shutdown().await.unwrap();
}

#[tokio::test]
async fn levels_keep_vendor_identity_on_the_topic_and_the_tool() {
    let h = start().await;
    let mut c = Client::new(&h).await;

    let sub = c
        .ok(
            "subscribe",
            json!({"topic": "intel.levels", "params": {"instrument": "QQQ"}}),
        )
        .await;
    let sid = sub["subscriptionId"].as_str().unwrap().to_owned();
    let snap = c.event(&sid, |p| p["seq"] == 0).await;
    let levels = snap["data"]["levels"].as_array().unwrap();
    assert_eq!(snap["data"]["instrument"], "QQQ");
    assert_eq!(snap["data"]["provider"], "mock-gamma");
    assert_eq!(levels.len(), 5);
    let flip = levels
        .iter()
        .find(|l| l["source"]["field"] == "zero_gamma")
        .expect("zero gamma");
    assert_eq!(flip["source"]["vendor"], "Mock");
    assert_eq!(flip["source"]["package"], "Gamma");
    assert_eq!(flip["source"]["basis"], "QQQ");
    assert!(flip["source"]["asOf"].is_number());
    assert!(flip["source"]["conversion"].is_null());
    assert_eq!(flip["price"], json!(485.4));

    let r = c
        .ok(
            "tools.invoke",
            json!({"name": "intel.get_levels", "input": {"instrument": "NQ"}}),
        )
        .await;
    assert_eq!(r["ok"], true, "{r}");
    assert_eq!(r["output"]["instrument"], "NQZ6.CME");
    let nq = r["output"]["levels"].as_array().unwrap();
    assert_eq!(nq.len(), 5);
    assert!(nq.iter().all(|l| l["source"]["basis"] == "NDX"));
    let gf = nq
        .iter()
        .find(|l| l["source"]["field"] == "zero_gamma")
        .unwrap();
    assert_eq!(gf["price"], json!(20652.75));
    assert_eq!(gf["nativePrice"], json!(20610));
    let conv = &gf["source"]["conversion"];
    assert_eq!(conv["from"], "NDX");
    assert_eq!(conv["to"], "NQZ6.CME");
    assert_eq!(conv["ratio"], json!(1.00208));
    assert_eq!(conv["method"], "spot_ratio");

    let r = c
        .ok(
            "tools.invoke",
            json!({"name": "intel.get_conversion", "input": {"from": "NDX", "to": "NQ"}}),
        )
        .await;
    assert_eq!(r["ok"], true, "{r}");
    assert_eq!(r["output"]["id"], conv["id"]);
    assert_eq!(r["output"]["fromPrice"], json!(20598.4));
    assert_eq!(r["output"]["toPrice"], json!(20641.25));
    let r = c
        .ok(
            "tools.invoke",
            json!({"name": "intel.get_conversion", "input": {"from": "NDX", "to": "ES"}}),
        )
        .await;
    assert_eq!(r["error"]["code"], "not_found");

    let r = c
        .ok(
            "tools.invoke",
            json!({"name": "intel.list_providers", "input": {}}),
        )
        .await;
    assert_eq!(r["ok"], true, "{r}");
    let p = &r["output"]["providers"][0];
    assert_eq!(p["providerId"], "mock-gamma");
    assert_eq!(p["health"]["kind"], "intelligence");

    let r = c
        .ok(
            "tools.invoke",
            json!({"name": "intel.get_levels", "input": {"instrument": "SPY"}}),
        )
        .await;
    assert_eq!(r["error"]["code"], "not_found");
    let r = c
        .ok(
            "tools.invoke",
            json!({"name": "intel.get_levels", "input": {"instrument": "QQQ", "asOf": "2026-10-01T10:00:00-04:00"}}),
        )
        .await;
    assert_eq!(r["error"]["code"], "not_found");

    let health = c
        .ok("subscribe", json!({"topic": "health", "params": {}}))
        .await;
    let hs = health["subscriptionId"].as_str().unwrap().to_owned();
    let ev = c.event(&hs, |p| p["seq"] == 0).await;
    let providers = ev["data"]["providers"].as_array().unwrap();
    let kinds: Vec<&str> = providers
        .iter()
        .map(|p| p["kind"].as_str().unwrap())
        .collect();
    assert_eq!(kinds, ["runtime", "market_data", "intelligence", "broker"]);
    assert_eq!(
        ev["data"]["pricesDown"],
        json!([]),
        "the mock market's prices flow"
    );
    assert_eq!(providers[3]["displayName"], "Tessera Paper");
    h.shutdown().await.unwrap();
}

#[tokio::test]
async fn seq_numbers_deliveries_per_subscription() {
    let h = start().await;
    let mut c = Client::new(&h).await;
    let mut subs = Vec::new();
    for instrument in ["QQQ", "NQ"] {
        let r = c
            .ok(
                "subscribe",
                json!({"topic": "market.quotes", "params": {"instruments": [instrument]}}),
            )
            .await;
        subs.push(r["subscriptionId"].as_str().unwrap().to_owned());
    }
    for sub in &subs {
        let snap = c.event(sub, |p| p["seq"] == 0).await;
        assert!(snap["data"]["instrument"].is_string());
        for expected in 1..=5u64 {
            let ev = c.event(sub, |p| p["seq"].as_u64().unwrap() > 0).await;
            assert_eq!(ev["seq"], expected, "subscription {sub}");
        }
    }
    h.shutdown().await.unwrap();
}

#[tokio::test]
async fn chart_tools_drive_the_layout_model() {
    let h = start().await;
    let mut c = Client::new(&h).await;
    let sub = c
        .ok("subscribe", json!({"topic": "layout", "params": {}}))
        .await;
    let ls = sub["subscriptionId"].as_str().unwrap().to_owned();
    let snap = c.event(&ls, |p| p["data"]["reason"] == "snapshot").await;
    let rev0 = snap["data"]["revision"].as_u64().unwrap();
    assert_eq!(snap["data"]["layout"]["name"], "Day · NQ/ES");
    assert_eq!(
        snap["data"]["layout"]["charts"]["chart-1"]["instrument"],
        "NQZ6.CME"
    );
    assert_eq!(
        snap["data"]["layout"]["charts"]["chart-2"]["instrument"],
        "ESZ6.CME"
    );

    let r = c
        .ok(
            "tools.invoke",
            json!({"name": "chart.set_symbol", "input": {"instrument": "NVDA"}}),
        )
        .await;
    assert_eq!(r["output"]["chart"]["instrument"], "NVDA", "{r}");
    let ev = c
        .event(&ls, |p| p["data"]["reason"] == "chart.set_symbol")
        .await;
    assert_eq!(ev["data"]["revision"].as_u64().unwrap(), rev0 + 1);
    assert_eq!(ev["data"]["tileId"], Value::Null);
    assert_eq!(
        ev["data"]["layout"]["charts"]["chart-1"]["instrument"],
        "NVDA"
    );

    let r = c
        .ok(
            "tools.invoke",
            json!({"name": "chart.set_timeframe", "input": {"tileId": "chart-2", "tf": "15m"}}),
        )
        .await;
    assert_eq!(r["output"]["chart"]["timeframe"], "15m");
    let r = c
        .ok(
            "tools.invoke",
            json!({"name": "chart.set_timeframe", "input": {"tf": "15s"}}),
        )
        .await;
    assert_eq!(r["output"]["chart"]["timeframe"], "15s", "{r}");
    let r = c
        .ok(
            "tools.invoke",
            json!({"name": "chart.set_timeframe", "input": {"tf": "1 week"}}),
        )
        .await;
    assert_eq!(r["error"]["code"], "invalid_input", "{r}");

    let r = c
        .ok(
            "tools.invoke",
            json!({"name": "chart.set_chart_type", "input": {"tileId": "chart-2", "chartType": "bars"}}),
        )
        .await;
    assert_eq!(r["output"]["chart"]["chartType"], "bars", "{r}");
    assert_eq!(
        r["output"]["chart"]["timeframe"], "15m",
        "nothing else changes"
    );
    let r = c
        .ok(
            "tools.invoke",
            json!({"name": "chart.set_chart_type", "input": {"chartType": "renko"}}),
        )
        .await;
    assert_eq!(r["error"]["code"], "invalid_input", "{r}");

    let r = c
        .ok(
            "tools.invoke",
            json!({"name": "chart.set_hours", "input": {"tileId": "chart-2", "hours": "rth"}}),
        )
        .await;
    assert_eq!(r["output"]["chart"]["hours"], "rth", "{r}");
    assert_eq!(
        r["output"]["chart"]["chartType"], "bars",
        "nothing else changes"
    );
    let r = c
        .ok(
            "tools.invoke",
            json!({"name": "chart.set_hours", "input": {"tileId": "chart-2", "hours": "eth"}}),
        )
        .await;
    assert!(
        r["output"]["chart"].get("hours").is_none(),
        "every hour is the default, so a chart set back to it reads like one never set: {r}"
    );
    let r = c
        .ok(
            "tools.invoke",
            json!({"name": "chart.set_hours", "input": {"hours": "overnight"}}),
        )
        .await;
    assert_eq!(r["error"]["code"], "invalid_input", "{r}");

    let r = c
        .ok(
            "tools.invoke",
            json!({"name": "chart.add_layer", "input": {"kind": "ema", "params": {"period": 9}}}),
        )
        .await;
    let layers = r["output"]["chart"]["layers"].as_array().unwrap();
    assert_eq!(layers.last().unwrap()["id"], "ema-1");
    assert_eq!(layers.last().unwrap()["namespace"], "user");
    let r = c
        .ok(
            "tools.invoke",
            json!({"name": "chart.add_layer", "input": {"kind": "footprint"}}),
        )
        .await;
    assert_eq!(r["ok"], true, "{r}");
    assert_eq!(
        r["output"]["chart"]["layers"]
            .as_array()
            .unwrap()
            .last()
            .unwrap()["params"]["inputs"]["ratio"],
        3.0
    );
    for kind in ["volume_profile", "big_trades", "delta"] {
        let r = c
            .ok(
                "tools.invoke",
                json!({"name": "chart.add_layer", "input": {"kind": kind}}),
            )
            .await;
        assert_eq!(r["ok"], true, "{kind}: {r}");
    }
    for kind in ["sessions"] {
        let r = c
            .ok(
                "tools.invoke",
                json!({"name": "chart.add_layer", "input": {"kind": kind}}),
            )
            .await;
        assert_eq!(r["error"]["code"], "unsupported", "{kind}: {r}");
    }
    let r = c
        .ok(
            "tools.invoke",
            json!({"name": "chart.add_layer", "input": {"kind": "sma", "params": {"period": 0}}}),
        )
        .await;
    assert_eq!(r["error"]["code"], "invalid_input", "{r}");
    let r = c
        .ok(
            "tools.invoke",
            json!({"name": "chart.add_layer", "input": {"kind": "vwap", "params": {"bands": [1, 2.5]}}}),
        )
        .await;
    let vwap = r["output"]["chart"]["layers"]
        .as_array()
        .unwrap()
        .last()
        .unwrap()
        .clone();
    assert_eq!(vwap["params"]["inputs"]["band2"], false);
    assert_eq!(vwap["params"]["inputs"]["mult2"], 2.5);
    assert_eq!(vwap["params"]["inputs"]["band3"], false);
    assert_eq!(vwap["params"]["style"]["plots"]["vwap"]["color"], "mist");

    let r = c
        .ok(
            "tools.invoke",
            json!({"name": "chart.add_layer", "input": {"kind": "rsi", "id": "rsi-a",
                "params": {"inputs": {"length": 21}}}}),
        )
        .await;
    assert_eq!(r["ok"], true, "{r}");
    let r = c
        .ok(
            "tools.invoke",
            json!({"name": "chart.update_layer", "input": {"layerId": "rsi-a",
                "params": {"inputs": {"upper": 80}, "style": {"plots": {"rsi": {"color": "brass"}}}}}}),
        )
        .await;
    assert_eq!(r["ok"], true, "{r}");
    let rsi = r["output"]["chart"]["layers"]
        .as_array()
        .unwrap()
        .iter()
        .find(|l| l["id"] == "rsi-a")
        .cloned()
        .unwrap();
    assert_eq!(rsi["params"]["inputs"]["length"], 21);
    assert_eq!(rsi["params"]["inputs"]["upper"], 80.0);
    assert_eq!(rsi["params"]["style"]["plots"]["rsi"]["color"], "brass");
    let r = c
        .ok(
            "tools.invoke",
            json!({"name": "chart.update_layer", "input": {"layerId": "rsi-a", "visible": false}}),
        )
        .await;
    assert_eq!(r["ok"], true, "{r}");
    let r = c
        .ok(
            "tools.invoke",
            json!({"name": "chart.update_layer", "input": {"layerId": "rsi-a",
                "params": {"inputs": {"length": 1}}}}),
        )
        .await;
    assert_eq!(r["error"]["code"], "invalid_input", "{r}");
    let r = c
        .ok(
            "tools.invoke",
            json!({"name": "chart.update_layer", "input": {"layerId": "nope", "visible": true}}),
        )
        .await;
    assert_eq!(r["error"]["code"], "not_found", "{r}");
    for kind in ["wma", "atr", "bollinger", "macd", "stochastic", "volume"] {
        let r = c
            .ok(
                "tools.invoke",
                json!({"name": "chart.add_layer", "input": {"kind": kind}}),
            )
            .await;
        assert_eq!(r["ok"], true, "{kind}: {r}");
    }
    let compact = c
        .ok(
            "tools.invoke",
            json!({"name": "chart.list_layer_kinds", "input": {}}),
        )
        .await;
    let listed = compact["output"]["kinds"].as_array().unwrap();
    assert_eq!(listed.len(), 21, "{compact}");
    assert!(
        listed
            .iter()
            .all(|k| k.get("paramsSchema").is_none() && k["available"].is_boolean()),
        "a bare list names each kind without its schema"
    );
    assert!(
        compact.to_string().len() < 12_000,
        "a bare list is small enough to read: {} chars",
        compact.to_string().len()
    );
    let profile = c
        .ok(
            "tools.invoke",
            json!({"name": "chart.list_layer_kinds", "input": {"kind": "Volume profile"}}),
        )
        .await;
    let only = profile["output"]["kinds"].as_array().unwrap();
    assert_eq!(only.len(), 1, "{profile}");
    assert_eq!(only[0]["kind"], "volume_profile");
    assert!(
        only[0]["paramsSchema"].is_object(),
        "one kind comes in full"
    );
    let first = c
        .ok(
            "tools.invoke",
            json!({"name": "chart.list_layer_kinds", "input": {"limit": 2}}),
        )
        .await;
    assert_eq!(first["output"]["kinds"].as_array().unwrap().len(), 2);
    assert_eq!(first["output"]["omitted"], 19);
    let unknown = c
        .ok(
            "tools.invoke",
            json!({"name": "chart.list_layer_kinds", "input": {"kind": "renko"}}),
        )
        .await;
    assert_eq!(unknown["error"]["code"], "not_found", "{unknown}");
    let kinds = c
        .ok(
            "tools.invoke",
            json!({"name": "chart.list_layer_kinds", "input": {"full": true}}),
        )
        .await;
    let kind = |name: &str| {
        kinds["output"]["kinds"]
            .as_array()
            .unwrap()
            .iter()
            .find(|k| k["kind"] == name)
            .cloned()
            .unwrap()
    };
    assert_eq!(kind("vwap")["available"], true);
    assert_eq!(kind("vwap")["drawn"], true);
    assert_eq!(kind("rsi")["available"], true);
    assert_eq!(kind("rsi")["indicator"]["placement"], "pane");
    assert_eq!(
        kind("rsi")["paramsSchema"]["properties"]["inputs"]["properties"]["length"]["default"],
        14
    );
    assert_eq!(kind("sessions")["available"], false);
    assert_eq!(kind("footprint")["requires"], "footprint");
    assert_eq!(kind("delta")["indicator"]["placement"], "pane");
    assert_eq!(kind("delta")["indicator"]["group"], "order_flow");

    let r = c
        .ok(
            "tools.invoke",
            json!({"name": "chart.annotate", "input": {"kind": "zone",
                "points": [{"t": null, "price": 489.94}, {"t": null, "price": 490.06}],
                "label": "touch zone · Max +Gamma ±0.10 ATR"}}),
        )
        .await;
    assert_eq!(r["ok"], true, "{r}");
    let ann = &r["output"]["chart"]["annotations"][0];
    assert_eq!(ann["kind"], "zone");
    assert_eq!(ann["instrument"], "NVDA");
    let r = c
        .ok(
            "tools.invoke",
            json!({"name": "chart.annotate", "input": {"kind": "box", "points": [{"price": 1}]}}),
        )
        .await;
    assert_eq!(r["error"]["code"], "invalid_input");

    let r = c
        .ok(
            "tools.invoke",
            json!({"name": "chart.report_viewport", "input": {"tileId": "chart-1",
                "viewport": {"from": 1, "to": 2, "priceMin": 480, "priceMax": 490, "bars": 150, "reportedAt": 3}}}),
        )
        .await;
    assert_eq!(r["ok"], true, "{r}");
    let state = c
        .ok(
            "tools.invoke",
            json!({"name": "chart.get_state", "input": {}}),
        )
        .await;
    assert_eq!(state["output"]["chart"]["viewport"]["bars"], 150);
    assert_eq!(
        state["output"]["chart"]["layers"].as_array().unwrap().len(),
        13,
        "the EMA, the footprint, three more order-flow views, the VWAP, the RSI and six more indicators added above"
    );

    let r = c
        .ok(
            "tools.invoke",
            json!({"name": "chart.clear_annotations", "input": {"namespace": "user"}}),
        )
        .await;
    assert_eq!(r["output"]["removed"], 1);
    let r = c
        .ok(
            "tools.invoke",
            json!({"name": "chart.remove_layer", "input": {"layerId": "ema-1"}}),
        )
        .await;
    assert_eq!(r["output"]["removed"], 1);

    let current = c
        .ok("tools.invoke", json!({"name": "layout.get", "input": {}}))
        .await;
    let rev = current["output"]["revision"].as_u64().unwrap();
    let r = c
        .ok(
            "tools.invoke",
            json!({"name": "layout.save", "input": {"expectedRevision": rev, "dock": {"grid": "2x1"}, "activeChartId": "chart-2"}}),
        )
        .await;
    assert_eq!(r["output"]["revision"], rev + 1);
    let r = c
        .ok(
            "tools.invoke",
            json!({"name": "layout.save", "input": {"expectedRevision": rev, "name": "x"}}),
        )
        .await;
    assert_eq!(r["error"]["code"], "conflict");
    let stored = h.state.store.layouts().get("default").unwrap().unwrap();
    assert_eq!(stored.revision, rev + 1);
    assert_eq!(stored.dock, json!({"grid": "2x1"}));
    h.shutdown().await.unwrap();
}

#[tokio::test]
async fn layouts_list_delete_and_follow_the_default_setting() {
    let h = start().await;
    let mut c = Client::new(&h).await;
    let r = c
        .ok(
            "tools.invoke",
            json!({"name": "layout.save", "input": {"layoutId": "ws-2", "name": "Scalp"}}),
        )
        .await;
    assert_eq!(r["output"]["revision"], 1, "{r}");
    let r = c
        .ok("tools.invoke", json!({"name": "layout.list", "input": {}}))
        .await;
    let out = &r["output"];
    assert_eq!(out["activeId"], "default");
    let ids: Vec<&str> = out["layouts"]
        .as_array()
        .unwrap()
        .iter()
        .map(|l| l["id"].as_str().unwrap())
        .collect();
    assert_eq!(ids, ["default", "ws-2"]);
    let default = &out["layouts"][0];
    assert_eq!(default["charts"].as_array().unwrap().len(), 2);
    assert_eq!(default["charts"][0]["instrument"], "NQZ6.CME");
    assert!(default.get("dock").is_none(), "no dock tree in the list");

    let r = c
        .ok(
            "tools.invoke",
            json!({"name": "layout.delete", "input": {"layoutId": "default"}}),
        )
        .await;
    assert_eq!(r["error"]["code"], "invalid_input");
    c.ok(
        "tools.invoke",
        json!({"name": "settings.set", "input": {"key": "workspace.activeLayoutId", "value": "ws-2"}}),
    )
    .await;
    assert_eq!(h.state.layouts.active_id(), "ws-2");
    let r = c
        .ok(
            "tools.invoke",
            json!({"name": "layout.delete", "input": {"layoutId": "ws-2"}}),
        )
        .await;
    assert_eq!(r["error"]["code"], "invalid_input");
    c.ok(
        "tools.invoke",
        json!({"name": "settings.set", "input": {"key": "workspace.activeLayoutId", "value": "default"}}),
    )
    .await;
    let r = c
        .ok(
            "tools.invoke",
            json!({"name": "layout.delete", "input": {"layoutId": "ws-2"}}),
        )
        .await;
    assert_eq!(r["output"]["layoutId"], "ws-2", "{r}");
    assert!(h.state.store.layouts().get("ws-2").unwrap().is_none());
    let r = c
        .ok(
            "tools.invoke",
            json!({"name": "layout.delete", "input": {"layoutId": "ws-2"}}),
        )
        .await;
    assert_eq!(r["error"]["code"], "not_found");
    c.ok(
        "tools.invoke",
        json!({"name": "settings.set", "input": {"key": "workspace.activeLayoutId", "value": "nope"}}),
    )
    .await;
    assert_eq!(h.state.layouts.active_id(), "default");
    h.shutdown().await.unwrap();
}

#[tokio::test]
async fn open_tile_asks_the_desk_through_the_layouts_dock() {
    let h = start().await;
    let mut c = Client::new(&h).await;
    let before = h.state.layouts.get(None).unwrap();
    let r = c
        .ok(
            "tools.invoke",
            json!({"name": "workspace.open_tile", "input": {"kind": "dom", "instrument": "NQ"}}),
        )
        .await;
    let out = &r["output"];
    assert_eq!(out["layoutId"], "default", "{r}");
    assert_eq!(out["revision"], before.revision + 1);
    assert_eq!(out["request"]["kind"], "dom");
    let nq = out["request"]["params"]["instrument"].as_str().unwrap();
    assert!(nq.starts_with("NQ") && nq.len() > 2, "{nq}");
    assert_eq!(out["request"]["params"]["link"], json!(null));
    c.ok(
        "tools.invoke",
        json!({"name": "layout.save", "input": {"dock": {"grid": "2x1", "tessera": {"v": 2}}}}),
    )
    .await;
    let r = c
        .ok(
            "tools.invoke",
            json!({"name": "workspace.open_tile", "input": {"kind": "tape", "link": "1"}}),
        )
        .await;
    assert_eq!(
        r["output"]["request"]["params"],
        json!({"instrument": null, "link": "1"}),
        "{r}"
    );
    let stored = h.state.store.layouts().get("default").unwrap().unwrap();
    assert_eq!(stored.dock["grid"], "2x1");
    assert_eq!(stored.dock["tessera"]["v"], 2);
    let open = tessera_runtime::layout::tile_requests(&stored.dock);
    assert_eq!(
        open.len(),
        1,
        "the desk's save took the first request: {open:?}"
    );
    assert_eq!(open[0].kind.as_str(), "tape");
    let r = c
        .ok(
            "tools.invoke",
            json!({"name": "workspace.open_tile", "input": {"kind": "dom", "settings": {"traded": "recent", "pullStack": 10}}}),
        )
        .await;
    assert_eq!(
        r["output"]["request"]["params"]["settings"],
        json!({"traded": "recent", "pullStack": 10}),
        "{r}"
    );
    let r = c
        .ok(
            "tools.invoke",
            json!({"name": "workspace.open_tile", "input": {"kind": "dom", "settings": 4}}),
        )
        .await;
    assert_eq!(r["error"]["code"], "invalid_input", "{r}");
    let r = c
        .ok(
            "tools.invoke",
            json!({"name": "workspace.open_tile", "input": {"kind": "dom", "link": "5"}}),
        )
        .await;
    assert_eq!(r["error"]["code"], "invalid_input", "{r}");
    let r = c
        .ok(
            "tools.invoke",
            json!({"name": "workspace.open_tile", "input": {"kind": "ladder"}}),
        )
        .await;
    assert!(r["error"].is_object(), "{r}");
    let r = c
        .ok(
            "tools.invoke",
            json!({"name": "workspace.open_tile", "input": {"kind": "dom", "layoutId": "nope"}}),
        )
        .await;
    assert_eq!(r["error"]["code"], "not_found", "{r}");
    h.shutdown().await.unwrap();
}

#[tokio::test]
async fn settings_tools() {
    let h = start().await;
    let mut c = Client::new(&h).await;
    let r = c
        .ok(
            "tools.invoke",
            json!({"name": "settings.get", "input": {"keys": ["agent.maxStepsPerTurn"]}}),
        )
        .await;
    assert_eq!(
        r["output"]["settings"]["agent.maxStepsPerTurn"]["value"],
        20
    );
    let r = c
        .ok(
            "tools.invoke",
            json!({"name": "settings.set", "input": {"key": "agent.maxStepsPerTurn", "value": 25}}),
        )
        .await;
    assert_eq!(r["output"]["previous"], 20);
    assert_eq!(
        h.state.invoker.limits().max_steps_per_turn,
        25,
        "applied live"
    );
    let r = c
        .ok("tools.invoke", json!({"name": "settings.set", "input": {"key": "appearance.upDownColors", "value": "purple"}}))
        .await;
    assert_eq!(r["error"]["code"], "invalid_input");
    h.shutdown().await.unwrap();
}

#[tokio::test]
async fn chart_templates_save_apply_edit_and_delete() {
    let h = start().await;
    let mut c = Client::new(&h).await;
    let call = |name: &str, input: Value| json!({"name": name, "input": input});
    let r = c
        .ok("tools.invoke", call("chart.list_templates", json!({})))
        .await;
    assert!(
        r["output"].get("defaultId").is_none(),
        "a new chart starts without a template"
    );
    assert_eq!(r["output"]["templates"][0]["layers"][0]["kind"], "volume");

    c.ok(
        "tools.invoke",
        call(
            "chart.add_layer",
            json!({"kind": "rsi", "params": {"inputs": {"length": 9}}}),
        ),
    )
    .await;
    let r = c
        .ok(
            "tools.invoke",
            call(
                "chart.save_template",
                json!({"name": " Scalp ", "chartType": "bars", "default": true}),
            ),
        )
        .await;
    assert_eq!(r["ok"], true, "{r}");
    let t = &r["output"]["template"];
    assert_eq!(t["id"], "scalp");
    assert_eq!(t["name"], "Scalp");
    assert_eq!(t["chartType"], "bars");
    let kinds: Vec<&str> = t["layers"]
        .as_array()
        .unwrap()
        .iter()
        .map(|l| l["kind"].as_str().unwrap())
        .collect();
    assert_eq!(kinds, ["rsi"], "indicators only, in order");
    assert_eq!(t["layers"][0]["params"]["inputs"]["length"], 9);
    assert_eq!(r["output"]["replaced"], false);
    assert_eq!(r["output"]["defaultId"], "scalp");
    let r = c
        .ok(
            "tools.invoke",
            call("chart.save_template", json!({"name": "SCALP"})),
        )
        .await;
    assert_eq!(r["output"]["replaced"], true, "{r}");
    assert_eq!(r["output"]["template"]["id"], "scalp");
    assert!(
        r["output"]["template"].get("chartType").is_none(),
        "no type picked on the chart: none recorded"
    );
    c.ok(
        "tools.invoke",
        call(
            "chart.save_template",
            json!({"name": "Scalp", "chartType": "bars"}),
        ),
    )
    .await;

    let before = c
        .ok(
            "tools.invoke",
            call("chart.get_state", json!({"tileId": "chart-2"})),
        )
        .await;
    let r = c
        .ok(
            "tools.invoke",
            call(
                "chart.apply_template",
                json!({"tileId": "chart-2", "template": "scalp"}),
            ),
        )
        .await;
    assert_eq!(r["ok"], true, "{r}");
    let chart = &r["output"]["chart"];
    assert_eq!(chart["chartType"], "bars");
    assert_eq!(chart["instrument"], before["output"]["chart"]["instrument"]);
    let ids: Vec<&str> = chart["layers"]
        .as_array()
        .unwrap()
        .iter()
        .map(|l| l["id"].as_str().unwrap())
        .collect();
    assert_eq!(ids, ["rsi-1"]);
    let r = c
        .ok(
            "tools.invoke",
            call("chart.apply_template", json!({"template": "nope"})),
        )
        .await;
    assert_eq!(r["error"]["code"], "not_found", "{r}");

    let r = c
        .ok(
            "tools.invoke",
            call(
                "chart.edit_template",
                json!({"template": "Scalp", "name": "Scalp NQ"}),
            ),
        )
        .await;
    assert_eq!(r["output"]["templates"][1]["name"], "Scalp NQ", "{r}");
    assert_eq!(r["output"]["templates"][1]["id"], "scalp", "the id stays");
    let r = c
        .ok(
            "tools.invoke",
            call(
                "chart.edit_template",
                json!({"template": "scalp", "name": "standard"}),
            ),
        )
        .await;
    assert_eq!(r["error"]["code"], "conflict", "{r}");
    let r = c
        .ok(
            "tools.invoke",
            call(
                "chart.edit_template",
                json!({"template": "scalp", "default": false}),
            ),
        )
        .await;
    assert!(r["output"].get("defaultId").is_none(), "{r}");
    let r = c
        .ok(
            "tools.invoke",
            call("chart.delete_template", json!({"template": "Scalp NQ"})),
        )
        .await;
    assert_eq!(r["output"]["templates"].as_array().unwrap().len(), 1, "{r}");
    let r = c
        .ok(
            "tools.invoke",
            call(
                "settings.set",
                json!({"key": "chart.templates", "value": {"templates": [{"id": "x", "name": "X", "layers": [{"kind": "levels"}]}]}}),
            ),
        )
        .await;
    assert_eq!(r["error"]["code"], "invalid_input", "{r}");
    h.shutdown().await.unwrap();
}

#[tokio::test]
async fn financial_calls_need_the_users_approval() {
    let h = start().await;
    let mut c = Client::new(&h).await;
    let sub = c.ok("subscribe", json!({"topic": "approvals"})).await;
    let aps = sub["subscriptionId"].as_str().unwrap().to_owned();
    let snap = c.event(&aps, |p| p["data"]["type"] == "snapshot").await;
    assert_eq!(snap["data"]["pending"], json!([]));

    let input = json!({"account": "paper-main", "symbol": "QQQ", "qty": 25});
    let r = c
        .ok(
            "tools.invoke",
            json!({"name": "test.submit", "input": input}),
        )
        .await;
    assert_eq!(r["status"], "pending_approval", "{r}");
    assert_eq!(r["output"]["status"], "pending_approval");
    let approval_id = r["approval"]["approvalId"].clone();
    let hash = r["approval"]["previewHash"].as_str().unwrap().to_owned();
    assert!(r["approval"]["draftId"].is_string());
    let requested = c.event(&aps, |p| p["data"]["type"] == "requested").await;
    assert_eq!(requested["data"]["approval"]["id"], approval_id);
    assert_eq!(requested["data"]["approval"]["environment"], "paper");
    assert_eq!(
        requested["data"]["approval"]["preview"]["restatement"],
        "BUY 25 QQQ LMT"
    );

    let r = c
        .ok(
            "tools.invoke",
            json!({"name": "test.submit", "input": input}),
        )
        .await;
    assert_eq!(r["status"], "denied");
    assert_eq!(r["error"]["code"], "loop_guard");

    let e = c
        .call(
            "approvals.resolve",
            json!({"approvalId": approval_id, "decision": "approve", "previewHash": "0000"}),
        )
        .await;
    assert_eq!(e["error"]["code"], -32010);
    let res = c
        .ok(
            "approvals.resolve",
            json!({"approvalId": approval_id, "decision": "approve", "previewHash": hash}),
        )
        .await;
    assert_eq!(res["approval"]["status"], "approved");
    assert_eq!(res["result"]["ok"], true);
    assert_eq!(res["result"]["output"]["submitted"], 25);
    assert_eq!(res["result"]["output"]["approvedBy"], approval_id);
    let resolved = c.event(&aps, |p| p["data"]["type"] == "resolved").await;
    assert_eq!(resolved["data"]["approval"]["status"], "approved");
    let e = c
        .call(
            "approvals.resolve",
            json!({"approvalId": approval_id, "decision": "approve", "previewHash": hash}),
        )
        .await;
    assert_eq!(e["error"]["code"], -32012);
    let e = c
        .call(
            "approvals.resolve",
            json!({"approvalId": "apr_missing", "decision": "reject", "previewHash": hash}),
        )
        .await;
    assert_eq!(e["error"]["code"], -32004);
    let stored = settle(
        "the approval is stored as approved",
        || {
            h.state
                .store
                .approvals()
                .get(approval_id.as_str().unwrap())
                .unwrap()
                .map(|a| a.status)
        },
        |status| *status == Some(tessera_protocol::tools::ApprovalStatus::Approved),
    )
    .await;
    assert_eq!(
        stored,
        Some(tessera_protocol::tools::ApprovalStatus::Approved)
    );
    h.shutdown().await.unwrap();
}

#[tokio::test]
async fn batches_and_notifications() {
    let h = start().await;
    let mut c = Client::new(&h).await;
    let batch = json!([
        {"jsonrpc": "2.0", "id": 1, "method": "session.hello", "params": {}},
        {"jsonrpc": "2.0", "method": "session.hello", "params": {}},
        {"jsonrpc": "2.0", "id": 2, "method": "tools.invoke", "params": {"name": "settings.get", "input": {}}}
    ]);
    c.ws.send(Message::text(batch.to_string())).await.unwrap();
    let v = c.recv().await;
    let arr = v.as_array().expect("batch response");
    assert_eq!(arr.len(), 2, "the notification gets no response");
    assert_eq!(arr[0]["id"], 1);
    assert_eq!(arr[1]["result"]["ok"], true);
    c.ws.send(Message::text("{not json")).await.unwrap();
    assert_eq!(c.recv().await["error"]["code"], -32700);
    c.ws.send(Message::text("[]")).await.unwrap();
    assert_eq!(c.recv().await["error"]["code"], -32600);
    h.shutdown().await.unwrap();
}

#[tokio::test]
async fn who_may_open_the_users_socket() {
    let h = start().await;
    let port = h.port;
    let get = |path: &str, extra: &str| {
        format!("GET {path} HTTP/1.1\r\nHost: 127.0.0.1\r\n{extra}Connection: close\r\n\r\n")
    };
    let (status, body) = http(port, &get("/healthz", "")).await;
    assert_eq!(status, 200);
    assert!(body.contains("\"status\":\"ok\""));
    let page = format!("http://127.0.0.1:{port}");
    let refused = |answer: &Value, credential: &str| {
        answer["error"]["code"] == -32001 && answer["error"]["data"]["credential"] == credential
    };

    let mut ws = connect_page(port, &page).await;
    let answer = first_hello(&mut ws, json!({"client": {"name": "test"}})).await;
    assert!(refused(&answer, "missing"), "{answer}");
    assert!(answer.get("result").is_none());
    assert!(closed(&mut ws).await);
    let mut ws = connect_page(port, &page).await;
    let subscribe = json!({"jsonrpc": "2.0", "id": 7, "method": "subscribe",
                           "params": {"topic": "quotes", "params": {"instrument": "NQ"}}});
    let answer = first(&mut ws, &subscribe.to_string()).await;
    assert!(refused(&answer, "missing"), "{answer}");
    assert!(closed(&mut ws).await);

    // A 127.0.0.1 cookie would go to every other local port.
    for (url, cookie) in [
        (format!("ws://127.0.0.1:{port}/ws?token={}", h.token), None),
        (
            format!("ws://127.0.0.1:{port}/ws"),
            Some(format!("tessera_token={}", h.token)),
        ),
    ] {
        let mut req = url.into_client_request().unwrap();
        req.headers_mut().insert("Origin", page.parse().unwrap());
        if let Some(c) = cookie {
            req.headers_mut().insert("Cookie", c.parse().unwrap());
        }
        let (mut ws, _) = tokio_tungstenite::connect_async(req).await.unwrap();
        let answer = first_hello(&mut ws, json!({})).await;
        assert!(refused(&answer, "missing"), "{answer}");
    }

    let mut ws = connect_page(port, &page).await;
    let stale = format!("tss_{}", "0".repeat(64));
    let answer = first_hello(&mut ws, json!({"token": stale})).await;
    assert!(refused(&answer, "invalid"), "{answer}");
    assert!(closed(&mut ws).await);

    let other_port = if port == u16::MAX { port - 1 } else { port + 1 };
    for origin in [
        page.clone(),
        "http://localhost:5173".to_owned(),
        format!("http://127.0.0.1:{other_port}"),
        "tauri://localhost".to_owned(),
        "https://review.example.test".to_owned(),
    ] {
        let mut ws = connect_page(port, &origin).await;
        let answer = first_hello(&mut ws, json!({"token": h.token})).await;
        let hello = &answer["result"];
        assert_eq!(hello["protocolVersion"], 1, "{origin}: {answer}");
        assert!(hello["reloadTicket"].as_str().unwrap().starts_with("tst_"));
        assert!(hello.get("token").is_none(), "{answer}");
    }

    let mut c = Client::new(&h).await;
    let hello = c.ok("session.hello", json!({})).await;
    assert!(hello.get("reloadTicket").is_none(), "{hello}");
    let wrong = format!("Bearer tss_{}", "1".repeat(64));
    let mut req = format!("ws://127.0.0.1:{port}/ws")
        .into_client_request()
        .unwrap();
    req.headers_mut()
        .insert("Authorization", wrong.parse().unwrap());
    match tokio_tungstenite::connect_async(req).await {
        Err(tungstenite::Error::Http(resp)) => assert_eq!(resp.status(), 401),
        other => panic!("expected 401, got {other:?}"),
    }

    let mut req = format!("ws://127.0.0.1:{port}/ws")
        .into_client_request()
        .unwrap();
    req.headers_mut()
        .insert("Origin", "https://evil.example".parse().unwrap());
    req.headers_mut().insert(
        "Authorization",
        format!("Bearer {}", h.token).parse().unwrap(),
    );
    match tokio_tungstenite::connect_async(req).await {
        Err(tungstenite::Error::Http(resp)) => assert_eq!(resp.status(), 403),
        other => panic!("expected 403, got {other:?}"),
    }

    let (status, body) = http(
        port,
        &get(
            "/api/session",
            &format!("Authorization: Bearer {}\r\n", h.token),
        ),
    )
    .await;
    assert_eq!(status, 404, "{body}");
    assert!(!body.contains(&h.token[4..]));
    let (status, resp) = http(port, &get(&format!("/?token={}", h.token), "")).await;
    assert_eq!(status, 200, "{resp}");
    let lower = resp.to_ascii_lowercase();
    assert!(!lower.contains("set-cookie"), "{resp}");
    assert!(lower.contains("cache-control: no-cache"), "{resp}");
    assert!(lower.contains("referrer-policy: no-referrer"), "{resp}");

    let (status, _) = http(
        port,
        "GET /mcp HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n",
    )
    .await;
    assert_eq!(status, 405);
    let (status, body) = http(
        port,
        "GET / HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n",
    )
    .await;
    assert_eq!(status, 200);
    assert!(body.contains("No UI is served"));
    let (_, raw) = http(
        port,
        "GET / HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n",
    )
    .await;
    let lower = raw.to_ascii_lowercase();
    assert!(lower.contains("x-frame-options: deny"), "{raw}");
    assert!(lower.contains("frame-ancestors 'none'"), "{raw}");
    h.shutdown().await.unwrap();
}

#[tokio::test]
async fn a_reloaded_page_gets_back_in_once_with_its_ticket() {
    let h = start().await;
    let page = format!("http://127.0.0.1:{}", h.port);
    let mut ws = connect_page(h.port, &page).await;
    let answer = first_hello(&mut ws, json!({"token": h.token})).await;
    let ticket = answer["result"]["reloadTicket"]
        .as_str()
        .unwrap()
        .to_owned();
    ws.close(None).await.unwrap();
    drop(ws);

    let mut ws = connect_page(h.port, &page).await;
    let answer = first_hello(&mut ws, json!({"ticket": ticket})).await;
    let hello = &answer["result"];
    assert_eq!(hello["token"], h.token, "{answer}");
    let next = hello["reloadTicket"].as_str().unwrap().to_owned();
    assert_ne!(next, ticket);
    let tools = first(
        &mut ws,
        &json!({"jsonrpc": "2.0", "id": 2, "method": "tools.list", "params": {}}).to_string(),
    )
    .await;
    assert!(
        tools["result"].as_array().is_some_and(|t| !t.is_empty()),
        "{tools}"
    );

    let mut again = connect_page(h.port, &page).await;
    let answer = first_hello(&mut again, json!({"ticket": ticket})).await;
    assert_eq!(answer["error"]["data"]["credential"], "missing", "{answer}");

    let mut c = Client::new(&h).await;
    let hello = c.ok("session.hello", json!({"ticket": next})).await;
    assert!(
        hello.get("token").is_none() && hello.get("reloadTicket").is_none(),
        "{hello}"
    );
    let mut later = connect_page(h.port, &page).await;
    let answer = first_hello(&mut later, json!({"ticket": next})).await;
    assert_eq!(answer["result"]["token"], h.token, "{answer}");
    h.shutdown().await.unwrap();
}

#[tokio::test]
async fn a_launch_ticket_lets_one_page_in_once() {
    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<String>();
    let sink: tessera_runtime::auth::LaunchSink =
        Arc::new(move |t: &tessera_core::token::Secret| {
            let _ = tx.send(t.expose().to_owned());
        });
    let config = RuntimeConfig {
        launch_tickets: Some(sink),
        ..RuntimeConfig::default()
    };
    let rt = Runtime::build(config, vec![Fakes::still(1).module()])
        .await
        .unwrap();
    assert!(rx.try_recv().is_err(), "nothing before the ready line");
    rt.state().tickets.announce_launch();
    let h = rt.spawn();
    let first = rx.recv().await.unwrap();
    assert!(first.starts_with("tst_"));
    let page = format!("http://127.0.0.1:{}", h.port);

    let mut ws = connect_page(h.port, &page).await;
    let answer = first_hello(&mut ws, json!({"ticket": first})).await;
    assert_eq!(answer["result"]["token"], h.token, "{answer}");
    let next = rx.recv().await.unwrap();
    assert_ne!(next, first);

    let mut again = connect_page(h.port, &page).await;
    let answer = first_hello(&mut again, json!({"ticket": first})).await;
    assert_eq!(answer["error"]["data"]["credential"], "missing", "{answer}");
    let mut wrong = connect_page(h.port, &page).await;
    let answer = first_hello(&mut wrong, json!({"token": next})).await;
    assert_eq!(answer["error"]["data"]["credential"], "invalid", "{answer}");
    let mut fresh = connect_page(h.port, &page).await;
    let answer = first_hello(&mut fresh, json!({"ticket": next})).await;
    assert_eq!(answer["result"]["token"], h.token, "{answer}");
    h.shutdown().await.unwrap();
}

#[tokio::test]
async fn serves_the_ui_with_spa_fallback() {
    let dir = tempfile::tempdir().unwrap();
    std::fs::write(
        dir.path().join("index.html"),
        "<!doctype html><title>Tessera</title>",
    )
    .unwrap();
    std::fs::create_dir_all(dir.path().join("assets")).unwrap();
    std::fs::write(dir.path().join("assets/app.js"), "console.log(1)").unwrap();
    let config = RuntimeConfig {
        ui_dir: Some(dir.path().to_path_buf()),
        ..RuntimeConfig::default()
    };
    let h = Runtime::build(config, vec![Fakes::still(2).module()])
        .await
        .unwrap()
        .spawn();
    let get =
        |path: &str| format!("GET {path} HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n");
    let (s, body) = http(h.port, &get("/")).await;
    assert_eq!(s, 200);
    assert!(body.contains("<title>Tessera</title>"));
    assert!(
        body.to_ascii_lowercase()
            .contains("cache-control: no-cache")
    );
    assert!(!body.to_ascii_lowercase().contains("set-cookie"));
    let (s, body) = http(h.port, &get("/assets/app.js")).await;
    assert_eq!(s, 200);
    assert!(body.contains("console.log(1)"));
    let (s, body) = http(h.port, &get("/research/rs_2a91")).await;
    assert_eq!(s, 200, "client-side routes fall back to index.html");
    assert!(body.contains("<title>Tessera</title>"));
    assert!(
        body.to_ascii_lowercase()
            .contains("x-content-type-options: nosniff")
    );
    h.shutdown().await.unwrap();
}

#[tokio::test]
async fn data_dir_persists_layouts_and_settings_across_restarts() {
    let dir = tempfile::tempdir().unwrap();
    let config = || RuntimeConfig {
        data_dir: Some(dir.path().to_path_buf()),
        ..RuntimeConfig::default()
    };
    let h = Runtime::build(config(), vec![Fakes::still(2).module()])
        .await
        .unwrap()
        .spawn();
    let err = Runtime::build(config(), vec![Fakes::still(2).module()])
        .await
        .unwrap_err();
    assert!(
        format!("{err:#}").contains("in use by another tessera-runtime"),
        "{err:#}"
    );
    let mut c = Client::new(&h).await;
    c.ok(
        "tools.invoke",
        json!({"name": "chart.set_symbol", "input": {"instrument": "TSLA"}}),
    )
    .await;
    c.ok(
        "tools.invoke",
        json!({"name": "settings.set", "input": {"key": "appearance.density", "value": 20}}),
    )
    .await;
    drop(c);
    h.shutdown().await.unwrap();
    for sub in ["blobs", "ticks", "logs"] {
        assert!(dir.path().join(sub).is_dir(), "{sub}");
    }
    assert!(dir.path().join("tessera.db").is_file());

    let h = Runtime::build(config(), vec![Fakes::still(2).module()])
        .await
        .unwrap()
        .spawn();
    let mut c = Client::new(&h).await;
    let r = c
        .ok(
            "tools.invoke",
            json!({"name": "chart.get_state", "input": {}}),
        )
        .await;
    assert_eq!(r["output"]["chart"]["instrument"], "TSLA");
    let r = c
        .ok(
            "tools.invoke",
            json!({"name": "settings.get", "input": {"keys": ["appearance.density"]}}),
        )
        .await;
    assert_eq!(r["output"]["settings"]["appearance.density"]["value"], 20);
    h.shutdown().await.unwrap();
}

#[tokio::test]
async fn order_flow_streams_and_tools_over_rpc() {
    let h = start().await;
    let mut c = Client::new(&h).await;
    let sub = |c: Value| c["subscriptionId"].as_str().unwrap().to_owned();

    let trades = sub(c
        .ok(
            "subscribe",
            json!({"topic": "market.trades", "params": {"instruments": ["NQ"]}}),
        )
        .await);
    let snap = c.event(&trades, |e| e["seq"] == 0).await;
    assert_eq!(snap["data"]["instrument"], "NQZ6.CME");
    assert_eq!(snap["data"]["trades"].as_array().unwrap().len(), 200);
    assert_eq!(snap["data"]["trades"][0].as_array().unwrap().len(), 4);
    assert_eq!(snap["data"]["aggressorSource"], "exchange");
    let mut last = snap["data"]["seq"].as_u64().unwrap();
    for _ in 0..3 {
        let live = c.event(&trades, |e| e["seq"].as_u64() > Some(0)).await;
        let seq = live["data"]["seq"].as_u64().unwrap();
        if seq <= last {
            continue;
        }
        let n = live["data"]["trades"].as_array().unwrap().len() as u64;
        assert_eq!(seq, last + n, "no print lost or repeated");
        last = seq;
    }

    let depth = sub(c
        .ok(
            "subscribe",
            json!({"topic": "market.depth", "params": {"instrument": "ES", "levels": 5}}),
        )
        .await);
    let first = c.event(&depth, |_| true).await;
    assert_eq!(first["data"]["kind"], "snapshot");
    assert_eq!(first["data"]["levels"], 5);
    assert_eq!(first["data"]["bids"].as_array().unwrap().len(), 5);
    assert_eq!(first["data"]["bids"][0].as_array().unwrap().len(), 3);
    let delta = c.event(&depth, |e| e["data"]["kind"] == "delta").await;
    assert_eq!(
        delta["data"]["seq"].as_u64().unwrap(),
        first["data"]["seq"].as_u64().unwrap() + 1
    );

    let fp = sub(c
        .ok(
            "subscribe",
            json!({"topic": "market.footprint", "params": {"instrument": "NQ", "tf": "1m", "rowTicks": 4}}),
        )
        .await);
    let bar = c.event(&fp, |e| e["seq"].as_u64() > Some(0)).await;
    assert_eq!(bar["data"]["bar"]["row"], 1);
    assert!(bar["data"]["bar"]["volume"].as_f64().unwrap() > 0.0);
    assert!(!bar["data"]["bar"]["cells"].as_array().unwrap().is_empty());

    let r = c
        .ok(
            "tools.invoke",
            json!({"name": "market.get_trades", "input": {"instrument": "NQ", "limit": 100}}),
        )
        .await;
    assert_eq!(r["ok"], true, "{r}");
    assert_eq!(r["output"]["trades"].as_array().unwrap().len(), 100);
    assert_eq!(
        r["output"]["columns"],
        json!(["t", "price", "size", "side", "order"])
    );
    let r = c
        .ok(
            "tools.invoke",
            json!({"name": "market.get_footprint", "input": {"instrument": "NQ", "tf": "5m", "limit": 3, "rowTicks": 1}}),
        )
        .await;
    assert_eq!(r["ok"], true, "{r}");
    let bars = r["output"]["bars"].as_array().unwrap();
    assert_eq!(bars.len(), 3);
    assert!(bars.iter().all(|b| b["volume"].as_f64().unwrap() > 0.0));
    assert_eq!(r["output"]["row"], 0.25);
    assert_eq!(r["output"]["imbalanceRatio"], 3.0);
    assert!(r["output"]["stackedImbalances"].is_array());
    let r = c
        .ok(
            "tools.invoke",
            json!({"name": "market.get_volume_profile", "input": {"instrument": "NQ", "session": "rth"}}),
        )
        .await;
    assert_eq!(r["ok"], true, "{r}");
    let p = &r["output"]["profiles"][0];
    assert!(p["volume"].as_f64().unwrap() > 0.0);
    assert!(p["val"].as_f64().unwrap() <= p["poc"].as_f64().unwrap());
    assert!(p["poc"].as_f64().unwrap() <= p["vah"].as_f64().unwrap());
    assert!(p["rows"].as_array().unwrap().len() <= 60);
    assert_eq!(p["rows"][0].as_array().unwrap().len(), 4);
    assert_eq!(r["output"]["valueAreaPercent"], 70.0);
    assert_eq!(r["output"]["aggressorSource"], "exchange");
    let r = c
        .ok(
            "tools.invoke",
            json!({"name": "market.get_big_trades", "input": {"instrument": "ES", "limit": 5}}),
        )
        .await;
    assert_eq!(r["ok"], true, "{r}");
    assert!(r["output"]["trades"].as_array().unwrap().len() <= 5);
    assert_eq!(r["output"]["rule"]["mode"], "auto");
    assert!(r["output"]["orders"].as_u64().unwrap() > 0);
    let r = c
        .ok(
            "tools.invoke",
            json!({"name": "market.get_delta", "input": {"instrument": "NQ", "tf": "5m", "limit": 6}}),
        )
        .await;
    assert_eq!(r["ok"], true, "{r}");
    assert_eq!(r["output"]["bars"].as_array().unwrap().len(), 6);
    assert_eq!(r["output"]["basis"], "bars");
    assert_eq!(
        r["output"]["columns"],
        json!([
            "t",
            "volume",
            "buyVolume",
            "sellVolume",
            "delta",
            "cumDelta"
        ])
    );
    let r = c
        .ok(
            "tools.invoke",
            json!({"name": "market.get_depth", "input": {"instrument": "QQQ", "levels": 5}}),
        )
        .await;
    assert_eq!(r["ok"], true, "{r}");
    assert_eq!(r["output"]["bids"].as_array().unwrap().len(), 5);
    assert!(
        r["output"]["bids"][0][0].as_f64().unwrap() < r["output"]["asks"][0][0].as_f64().unwrap()
    );
    h.shutdown().await.unwrap();
}

const DURING_SUBSCRIBE: &str = "test.during_subscribe";

struct PublishesWhileSubscribing(Arc<EventBus>);

#[async_trait]
impl TopicHandler for PublishesWhileSubscribing {
    fn name(&self) -> &'static str {
        DURING_SUBSCRIBE
    }

    fn sizing(&self) -> TopicSizing {
        TopicSizing {
            capacity: 8,
            replay: 0,
        }
    }

    async fn subscribe(&self, _params: Value) -> Result<Subscribed, RpcError> {
        self.0.publish(
            DURING_SUBSCRIBE,
            TopicKey::None,
            &json!({"published": "while subscribing"}),
        );
        Ok(Subscribed::new(KeyFilter::All))
    }
}

struct DuringSubscribeModule;

impl RuntimeModule for DuringSubscribeModule {
    fn name(&self) -> &'static str {
        DURING_SUBSCRIBE
    }

    fn topics(&self, host: &ModuleHost) -> Vec<Arc<dyn TopicHandler>> {
        vec![Arc::new(PublishesWhileSubscribing(Arc::clone(
            &host.ctx.bus,
        )))]
    }
}

#[tokio::test]
async fn an_event_published_while_a_subscription_starts_still_arrives() {
    let module: ModuleFactory =
        Box::new(|_| Ok(Arc::new(DuringSubscribeModule) as Arc<dyn RuntimeModule>));
    let h = Runtime::build(RuntimeConfig::default(), vec![module])
        .await
        .unwrap()
        .spawn();
    let mut c = Client::new(&h).await;
    let sub = c
        .ok(
            "subscribe",
            json!({"topic": DURING_SUBSCRIBE, "params": {}, "replay": false}),
        )
        .await;
    let id = sub["subscriptionId"].as_str().unwrap().to_owned();
    let ev = c
        .event(&id, |p| p["data"]["published"] == "while subscribing")
        .await;
    assert_eq!(ev["data"], json!({"published": "while subscribing"}));
    h.shutdown().await.unwrap();
}

const FLOOD: &str = "test.flood";

const FLOOD_EVENTS: usize = 4096;

struct Floods(Arc<EventBus>);

#[async_trait]
impl TopicHandler for Floods {
    fn name(&self) -> &'static str {
        FLOOD
    }

    fn sizing(&self) -> TopicSizing {
        TopicSizing {
            capacity: FLOOD_EVENTS,
            replay: 0,
        }
    }

    async fn subscribe(&self, _params: Value) -> Result<Subscribed, RpcError> {
        let filler = "x".repeat(8 * 1024);
        for n in 0..FLOOD_EVENTS {
            self.0
                .publish(FLOOD, TopicKey::None, &json!({"n": n, "filler": filler}));
        }
        Ok(Subscribed::new(KeyFilter::All))
    }
}

struct FloodModule;

impl RuntimeModule for FloodModule {
    fn name(&self) -> &'static str {
        FLOOD
    }

    fn topics(&self, host: &ModuleHost) -> Vec<Arc<dyn TopicHandler>> {
        vec![Arc::new(Floods(Arc::clone(&host.ctx.bus)))]
    }
}

#[tokio::test]
async fn a_page_that_reads_nothing_while_its_queue_is_full_still_has_its_requests_run() {
    let module: ModuleFactory = Box::new(|_| Ok(Arc::new(FloodModule) as Arc<dyn RuntimeModule>));
    let h = Runtime::build(RuntimeConfig::default(), vec![module])
        .await
        .unwrap()
        .spawn();
    let mut c = Client::new(&h).await;
    c.ok(
        "subscribe",
        json!({"topic": FLOOD, "params": {}, "replay": false}),
    )
    .await;
    tokio::time::sleep(Duration::from_secs(2)).await;
    for (id, method, params) in [
        (90, "unsubscribe", json!({"subscriptionId": "sub-none"})),
        (
            91,
            "tools.invoke",
            json!({"name": "settings.set", "input": {"key": "agent.maxStepsPerTurn", "value": 25}}),
        ),
    ] {
        let req = json!({"jsonrpc": "2.0", "id": id, "method": method, "params": params});
        c.ws.send(Message::text(req.to_string())).await.unwrap();
    }
    settle(
        "the request after the unsubscribe runs while the page reads nothing",
        || h.state.invoker.limits().max_steps_per_turn,
        |&steps| steps == 25,
    )
    .await;
    drop(c);
    h.shutdown().await.unwrap();
}

const GATED: &str = "test.gated";

const QUICK: &str = "test.quick";

struct Gate {
    open: tokio::sync::Semaphore,
    held: Arc<()>,
    arrived: std::sync::atomic::AtomicUsize,
}

struct Gated(Arc<Gate>);

#[async_trait]
impl TopicHandler for Gated {
    fn name(&self) -> &'static str {
        GATED
    }

    fn sizing(&self) -> TopicSizing {
        TopicSizing {
            capacity: 8,
            replay: 0,
        }
    }

    async fn subscribe(&self, _params: Value) -> Result<Subscribed, RpcError> {
        self.0
            .arrived
            .fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        let _open = self.0.open.acquire().await;
        Ok(Subscribed::new(KeyFilter::All).keep(Arc::clone(&self.0.held)))
    }
}

struct Quick;

#[async_trait]
impl TopicHandler for Quick {
    fn name(&self) -> &'static str {
        QUICK
    }

    fn sizing(&self) -> TopicSizing {
        TopicSizing {
            capacity: 8,
            replay: 0,
        }
    }

    async fn subscribe(&self, _params: Value) -> Result<Subscribed, RpcError> {
        Ok(Subscribed::new(KeyFilter::All))
    }
}

struct GateModule(Arc<Gate>);

impl RuntimeModule for GateModule {
    fn name(&self) -> &'static str {
        GATED
    }

    fn topics(&self, _host: &ModuleHost) -> Vec<Arc<dyn TopicHandler>> {
        vec![Arc::new(Gated(Arc::clone(&self.0))), Arc::new(Quick)]
    }
}

async fn gated_runtime() -> (RuntimeHandle, Arc<Gate>) {
    let gate = Arc::new(Gate {
        open: tokio::sync::Semaphore::new(0),
        held: Arc::new(()),
        arrived: std::sync::atomic::AtomicUsize::new(0),
    });
    let shared = Arc::clone(&gate);
    let module: ModuleFactory =
        Box::new(move |_| Ok(Arc::new(GateModule(Arc::clone(&shared))) as Arc<dyn RuntimeModule>));
    let h = Runtime::build(RuntimeConfig::default(), vec![module])
        .await
        .unwrap()
        .spawn();
    (h, gate)
}

async fn send_subscribe(c: &mut Client, id: i64, topic: &str) {
    let req = json!({"jsonrpc": "2.0", "id": id, "method": "subscribe",
        "params": {"topic": topic, "params": {}, "replay": false}});
    c.ws.send(Message::text(req.to_string())).await.unwrap();
}

async fn reply(c: &mut Client, id: i64) -> Value {
    loop {
        let v = c.recv().await;
        if v["id"] == json!(id) {
            return v;
        }
    }
}

#[tokio::test]
async fn a_subscribe_that_waits_holds_up_no_other_subscribe() {
    let (h, gate) = gated_runtime().await;
    let mut c = Client::new(&h).await;
    send_subscribe(&mut c, 1, GATED).await;
    send_subscribe(&mut c, 2, QUICK).await;
    let quick = reply(&mut c, 2).await;
    assert!(quick.get("error").is_none(), "{quick}");
    gate.open.add_permits(1);
    let gated = reply(&mut c, 1).await;
    assert!(gated.get("error").is_none(), "{gated}");
    h.shutdown().await.unwrap();
}

#[tokio::test]
async fn a_subscribe_still_waiting_when_the_page_closes_keeps_nothing() {
    let (h, gate) = gated_runtime().await;
    let mut c = Client::new(&h).await;
    send_subscribe(&mut c, 1, GATED).await;
    settle(
        "the subscribe waits at the gate",
        || gate.arrived.load(std::sync::atomic::Ordering::SeqCst),
        |&arrived| arrived == 1,
    )
    .await;
    drop(c);
    tokio::time::sleep(Duration::from_millis(100)).await;
    gate.open.add_permits(1);
    settle(
        "the closed page's subscription is let go",
        || Arc::strong_count(&gate.held),
        |&holders| holders == 1,
    )
    .await;
    h.shutdown().await.unwrap();
}

fn undescribed_properties(schema: &Value, at: &str, out: &mut Vec<String>) {
    if let Some(properties) = schema.get("properties").and_then(Value::as_object) {
        for (name, property) in properties {
            let at = format!("{at}.{name}");
            let serde_tag = property.get("const").is_some()
                || property
                    .get("enum")
                    .and_then(Value::as_array)
                    .is_some_and(|values| values.len() == 1);
            if property.get("description").is_none() && !serde_tag {
                out.push(at.clone());
            }
            undescribed_properties(property, &at, out);
        }
    }
    for key in ["items", "additionalProperties"] {
        if let Some(inner) = schema.get(key) {
            undescribed_properties(inner, at, out);
        }
    }
    for key in ["anyOf", "oneOf", "allOf", "prefixItems"] {
        for inner in schema
            .get(key)
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
        {
            undescribed_properties(inner, at, out);
        }
    }
}

#[tokio::test]
async fn every_tool_schema_property_has_a_description() {
    let rt = Runtime::build(RuntimeConfig::default(), vec![Fakes::default().module()])
        .await
        .unwrap();
    let h = rt.spawn();
    let mut c = Client::new(&h).await;
    let tools = c.ok("tools.list", json!({"includeHidden": true})).await;
    let mut missing = Vec::new();
    for tool in tools.as_array().unwrap() {
        let name = tool["name"].as_str().unwrap();
        undescribed_properties(&tool["inputSchema"], &format!("{name} input"), &mut missing);
        undescribed_properties(
            &tool["outputSchema"],
            &format!("{name} output"),
            &mut missing,
        );
    }
    assert!(
        missing.is_empty(),
        "tool schema properties without a description: {missing:#?}"
    );
}
