use std::sync::Arc;

use serde_json::{Value, json};
use tessera_core::Origin;
use tessera_core::ids::SessionId;
use tessera_protocol::agent::{
    AgentEvent, AgentEventEnvelope, AgentSessionStatus, AgentSessionSummary,
};
use tessera_protocol::methods::ApprovalsResolveParams;
use tessera_protocol::tools::{
    ApprovalDecision, ApprovalKind, SessionMode, ToolErrorCode, ToolOutcome, ToolResult,
};
use tessera_runtime::layout::dock_requests;
use tessera_runtime::state::SharedState;
use tessera_runtime::{Runtime, RuntimeConfig};
use tessera_testkit::Fakes;
use tessera_tools::{InvokeRequest, Invoker, SessionPolicy};

mod common;

fn agent() -> Origin {
    Origin::Agent {
        session_id: SessionId::new("S-parity"),
        provider: "codex".into(),
    }
}

async fn runtime() -> (Runtime, SharedState, Arc<Invoker>) {
    let config = RuntimeConfig {
        ..RuntimeConfig::default()
    };
    let rt = Runtime::build(config, vec![Fakes::still(1).module()])
        .await
        .unwrap();
    let state = Arc::clone(rt.state());
    let inv = Arc::clone(&state.invoker);
    inv.set_policy(&agent(), SessionPolicy::with_mode(SessionMode::AutoModify));
    (rt, state, inv)
}

async fn invoke(inv: &Invoker, name: &str, input: Value, origin: Origin) -> ToolResult {
    inv.invoke(InvokeRequest::new(name, input, origin)).await
}

async fn call(inv: &Invoker, name: &str, input: Value) -> Value {
    common::call(inv, &agent(), name, input).await
}

async fn refused(inv: &Invoker, name: &str, input: Value) -> (ToolErrorCode, String) {
    let r = invoke(inv, name, input.clone(), agent()).await;
    assert!(!r.ok, "{name} {input} should be refused: {r:?}");
    let e = r.error.unwrap();
    (e.code, e.message)
}

fn approve(r: &ToolResult) -> ApprovalsResolveParams {
    let p = r.approval.clone().expect("a pending approval");
    ApprovalsResolveParams {
        approval_id: p.approval_id,
        decision: ApprovalDecision::Approve,
        preview_hash: p.preview_hash,
        note: None,
        input: None,
        deadline: None,
        idempotency_key: None,
    }
}

fn ops(state: &SharedState) -> Vec<Value> {
    dock_requests(&state.layouts.get(None).unwrap().dock)
        .into_iter()
        .map(|r| serde_json::to_value(r).unwrap())
        .collect()
}

#[tokio::test]
async fn the_trade_panel_is_prepared_by_the_agent_and_allowed_by_the_user() {
    let (_rt, state, inv) = runtime().await;
    let input = json!({
        "tileId": "chart-1",
        "accountId": "paper-main",
        "qty": 2,
        "oco": {"stop": {"unit": "ticks", "value": 10}, "target": {"unit": "usd", "value": 400}, "trail": {"on": true, "ticks": 12}},
    });
    let r = invoke(&inv, "trade.set_panel", input.clone(), agent()).await;
    assert_eq!(
        r.status,
        ToolOutcome::PendingApproval,
        "Auto-modify asks too: {r:?}"
    );
    assert!(
        ops(&state).is_empty(),
        "nothing reaches the desk before the user allows it"
    );
    let pending = state
        .invoker
        .approvals()
        .get(&r.approval.clone().unwrap().approval_id)
        .unwrap();
    assert_eq!(pending.kind, ApprovalKind::Modify);
    let words = pending.preview["restatement"].as_str().unwrap().to_owned();
    assert!(
        words.starts_with("Trade panel of Chart 1")
            && words.contains("2 contracts")
            && words.contains("stop 10 ticks")
            && words.contains("target $400")
            && words.contains("trailing 12 ticks on"),
        "{words}"
    );
    assert!(inv.resolve(&approve(&r), &agent()).await.is_err());
    let done = inv.resolve(&approve(&r), &Origin::User).await.unwrap();
    assert!(done.result.as_ref().is_some_and(|x| x.ok), "{done:?}");
    let asked = ops(&state);
    assert_eq!(asked.len(), 1);
    assert_eq!(asked[0]["op"], "trade");
    assert_eq!(asked[0]["tileId"], "chart-1");
    assert_eq!(
        asked[0]["settings"],
        json!({"accountId": "paper-main", "qty": 2, "oco": {
            "stop": {"unit": "ticks", "value": 10.0},
            "target": {"unit": "usd", "value": 400.0},
            "trail": {"on": true, "ticks": 12},
        }})
    );

    for bad in [
        json!({"qty": 0}),
        json!({"accountId": "no-such-account"}),
        json!({"stopLimitTicks": 100}),
        json!({}),
        json!({"tileId": "chart-9", "qty": 1}),
    ] {
        let r = invoke(&inv, "trade.set_panel", bad.clone(), agent()).await;
        assert!(!r.ok && r.approval.is_none(), "{bad}: {r:?}");
    }
    let reader = Origin::Agent {
        session_id: SessionId::new("S-reader"),
        provider: "codex".into(),
    };
    inv.set_policy(&reader, SessionPolicy::with_mode(SessionMode::ReadOnly));
    let r = invoke(&inv, "trade.set_panel", json!({"qty": 3}), reader).await;
    assert_eq!(
        r.error.map(|e| e.code),
        Some(ToolErrorCode::PermissionDenied)
    );
    let r = invoke(&inv, "trade.set_panel", json!({"qty": 3}), Origin::User).await;
    assert!(r.ok, "{r:?}");
    let (code, _) = refused(&inv, "layout.save", json!({"trade": {"v": 2}})).await;
    assert_eq!(code, ToolErrorCode::PermissionDenied);

    let trade = json!({"v": 2, "tickets": {"chart-1": {"accountId": "eval-50k", "qty": 4, "sizing": "risk", "risk": 300}}, "oco": {"eval-50k|NQ": {"on": true, "stop": {"on": true, "unit": "ticks", "value": 20}}}});
    let r = invoke(&inv, "layout.save", json!({"trade": trade}), Origin::User).await;
    assert!(r.ok, "{r:?}");
    let panel = call(&inv, "trade.get_panel", json!({"tileId": "chart-1"})).await;
    assert_eq!(panel["ticket"]["accountId"], "eval-50k");
    assert_eq!(panel["ticket"]["qty"], 4);
    assert_eq!(panel["ticket"]["sizing"], "risk");
    assert_eq!(panel["ticket"]["own"], true);
    assert_eq!(panel["brackets"][0]["root"], "NQ");
    let other = call(&inv, "trade.get_panel", json!({"tileId": "chart-2"})).await;
    assert_eq!(other["ticket"]["own"], false);
    assert_eq!(other["ticket"]["qty"], 1);
}

#[tokio::test]
async fn the_view_the_history_and_maximize_are_asked_of_the_desk() {
    let (_rt, state, inv) = runtime().await;
    let dock = json!({
        "grid": {"root": {"type": "branch", "data": [
            {"type": "leaf", "data": {"views": ["chart-1", "chart-2"], "activeView": "chart-1", "id": "g1"}},
        ]}},
        "panels": {
            "chart-1": {"id": "chart-1", "contentComponent": "chart", "title": "Chart 1", "params": {}},
            "chart-2": {"id": "chart-2", "contentComponent": "chart", "title": "Chart 2", "params": {}},
            "trade": {"id": "trade", "contentComponent": "trade", "title": "Trade"},
            "analyst": {"id": "analyst", "contentComponent": "analyst", "title": "Analyst"},
            "positions": {"id": "positions", "contentComponent": "positions", "title": "Positions"},
        },
        "edgeGroups": {
            "right": {"visible": true, "group": {"views": ["trade", "analyst"], "activeView": "trade"}},
            "bottom": {"visible": true, "group": {"views": ["positions"], "activeView": "positions"}},
        },
        "tessera": {"v": 5},
    });
    call(&inv, "layout.save", json!({"dock": dock})).await;

    let v = call(
        &inv,
        "chart.set_viewport",
        json!({"from": "2026-10-02T13:30:00Z", "to": "2026-10-02T15:00:00Z", "autoScale": true}),
    )
    .await;
    assert_eq!(v["request"]["op"], "viewport");
    assert_eq!(v["request"]["tileId"], "chart-1");
    let s = &v["request"]["settings"];
    assert!(s["from"].as_i64().unwrap() < s["to"].as_i64().unwrap());
    assert_eq!(s["autoScale"], true);
    let v = call(
        &inv,
        "chart.set_viewport",
        json!({"tileId": "chart-2", "lastBars": 150, "priceMin": 20500, "priceMax": 20700}),
    )
    .await;
    assert_eq!(
        v["request"]["settings"],
        json!({"lastBars": 150, "priceMin": 20500.0, "priceMax": 20700.0})
    );
    for bad in [
        json!({}),
        json!({"lastBars": 100, "fitAll": true}),
        json!({"priceMin": 5}),
        json!({"priceMin": 9, "priceMax": 5}),
        json!({"priceMin": 1, "priceMax": 5, "autoScale": true}),
        json!({"to": "2026-10-02T15:00:00Z"}),
        json!({"lastBars": 0}),
        json!({"tileId": "chart-7", "fitAll": true}),
    ] {
        let (code, msg) = refused(&inv, "chart.set_viewport", bad.clone()).await;
        assert!(
            matches!(code, ToolErrorCode::InvalidInput | ToolErrorCode::NotFound),
            "{bad}: {msg}"
        );
    }

    let u = call(&inv, "chart.undo_drawing", json!({})).await;
    assert_eq!(u["request"]["op"], "drawings");
    assert_eq!(u["request"]["settings"], json!({"action": "undo"}));
    let r = call(&inv, "chart.redo_drawing", json!({"tileId": "chart-2"})).await;
    assert_eq!(r["request"]["settings"], json!({"action": "redo"}));

    let m = call(
        &inv,
        "workspace.maximize_tile",
        json!({"tileId": "chart-2"}),
    )
    .await;
    assert_eq!(m["request"]["op"], "maximize");
    assert_eq!(m["request"]["settings"], json!({"restore": false}));
    let m = call(
        &inv,
        "workspace.maximize_tile",
        json!({"kind": "chart", "restore": true}),
    )
    .await;
    assert_eq!(m["request"]["settings"], json!({"restore": true}));
    let a = call(&inv, "workspace.maximize_tile", json!({"kind": "analyst"})).await;
    assert_eq!(a["request"]["settings"], json!({"restore": false}));

    let view = call(&inv, "workspace.set_view", json!({"focus": true})).await;
    assert_eq!(view["request"]["settings"], json!({"focus": true}));
    refused(&inv, "workspace.set_view", json!({"sidebar": "tabs"})).await;

    let p = call(
        &inv,
        "workspace.set_tile_settings",
        json!({"tileId": "positions", "settings": {"account": "paper-main"}}),
    )
    .await;
    assert_eq!(p["request"]["settings"], json!({"account": "paper-main"}));
    refused(
        &inv,
        "workspace.set_tile_settings",
        json!({"tileId": "positions", "settings": {"account": ""}}),
    )
    .await;

    let j = call(&inv, "workspace.open_tile", json!({"kind": "journal"})).await;
    assert_eq!(j["request"]["kind"], "journal");

    let asked: Vec<String> = ops(&state)
        .iter()
        .map(|o| o["op"].as_str().unwrap().to_owned())
        .collect();
    assert_eq!(
        asked,
        [
            "viewport", "viewport", "drawings", "drawings", "maximize", "maximize", "maximize",
            "view", "settings"
        ]
    );
}

#[tokio::test]
async fn the_agent_makes_and_copies_workspaces() {
    let (_rt, state, inv) = runtime().await;
    let made = call(
        &inv,
        "workspace.create",
        json!({"instrument": "NQ", "timeframe": "15m"}),
    )
    .await;
    let id = made["layoutId"].as_str().unwrap().to_owned();
    assert!(id.starts_with("ws-"), "{id}");
    assert_eq!(made["shown"], true);
    let l = state.layouts.get(Some(&id)).unwrap();
    assert_eq!(l.name, made["name"].as_str().unwrap());
    assert!(l.name.starts_with("Workspace "), "{}", l.name);
    let c = &l.charts["chart-1"];
    assert_eq!(c.timeframe.to_string(), "15m");
    assert!(c.instrument.as_str().starts_with("NQ"), "{}", c.instrument);
    assert!(
        c.layers.is_empty(),
        "a new workspace starts without studies: {:?}",
        c.layers
    );
    assert_eq!(state.settings.string("ui.workspace"), id);
    assert_eq!(state.settings.string("ui.area"), "desk");

    call(
        &inv,
        "layout.save",
        json!({"layoutId": id, "dock": {"panels": {"chart-1": {"params": {"layoutId": id, "tileId": "chart-1"}}}, "tessera": {"v": 3, "ops": [{"id": "op-9", "op": "focus"}]}}}),
    )
    .await;
    call(&inv, "chart.set_link", json!({"layoutId": id, "link": "2"})).await;
    let copy = call(&inv, "workspace.duplicate", json!({"show": false})).await;
    let copy_id = copy["layoutId"].as_str().unwrap();
    assert_ne!(copy_id, id);
    assert_eq!(copy["shown"], false);
    assert!(copy["name"].as_str().unwrap().ends_with(" copy"));
    let c = state.layouts.get(Some(copy_id)).unwrap();
    assert_eq!(c.charts["chart-1"].link_group.as_deref(), Some("2"));
    assert_eq!(c.dock["panels"]["chart-1"]["params"]["layoutId"], copy_id);
    assert!(c.dock["tessera"].get("ops").is_none());
    assert_eq!(c.trade, Value::Null, "the Trade panel setup is not copied");
    assert_eq!(state.settings.string("ui.workspace"), id, "not shown");
    refused(&inv, "workspace.duplicate", json!({"layoutId": "nowhere"})).await;
    refused(&inv, "workspace.create", json!({"name": "  "})).await;
}

#[tokio::test]
async fn a_new_workspace_takes_the_last_charted_or_chosen_instrument() {
    let (_rt, state, inv) = runtime().await;
    let made = call(
        &inv,
        "workspace.create",
        json!({"show": false, "name": "Last"}),
    )
    .await;
    let last = state
        .layouts
        .get(Some(made["layoutId"].as_str().unwrap()))
        .unwrap();
    assert!(
        last.charts["chart-1"].instrument.as_str().starts_with("NQ"),
        "{}",
        last.charts["chart-1"].instrument
    );

    state
        .settings
        .set("market.defaultInstrument", json!("ES"), &Origin::User)
        .await
        .unwrap();
    let made = call(
        &inv,
        "workspace.create",
        json!({"show": false, "name": "Chosen"}),
    )
    .await;
    let chosen = state
        .layouts
        .get(Some(made["layoutId"].as_str().unwrap()))
        .unwrap();
    assert!(
        chosen.charts["chart-1"]
            .instrument
            .as_str()
            .starts_with("ES"),
        "{}",
        chosen.charts["chart-1"].instrument
    );
}

#[tokio::test]
async fn a_new_workspace_follows_the_recent_symbol_and_otherwise_opens_empty() {
    let (_rt, state, inv) = runtime().await;
    let cleared = invoke(
        &inv,
        "layout.save",
        json!({"layoutId": "default", "charts": {}}),
        Origin::User,
    )
    .await;
    assert!(cleared.ok, "{cleared:?}");
    state
        .settings
        .set(
            "ui.preferences",
            json!({"recentSymbols": ["ES"]}),
            &Origin::User,
        )
        .await
        .unwrap();
    let made = call(
        &inv,
        "workspace.create",
        json!({"show": false, "name": "Recent"}),
    )
    .await;
    let id = made["layoutId"].as_str().unwrap();
    let recent = state.layouts.get(Some(id)).unwrap();
    assert!(
        recent.charts["chart-1"]
            .instrument
            .as_str()
            .starts_with("ES"),
        "{}",
        recent.charts["chart-1"].instrument
    );

    let cleared = invoke(
        &inv,
        "layout.save",
        json!({"layoutId": id, "charts": {}}),
        Origin::User,
    )
    .await;
    assert!(cleared.ok, "{cleared:?}");
    state
        .settings
        .set(
            "ui.preferences",
            json!({"recentSymbols": []}),
            &Origin::User,
        )
        .await
        .unwrap();
    let made = call(
        &inv,
        "workspace.create",
        json!({"show": false, "name": "Empty"}),
    )
    .await;
    let empty = state
        .layouts
        .get(Some(made["layoutId"].as_str().unwrap()))
        .unwrap();
    assert!(empty.charts.is_empty(), "{:?}", empty.charts);
    assert_eq!(empty.active_chart_id, None);
}

#[tokio::test]
async fn the_agent_opens_each_area_where_it_says() {
    let (_rt, state, inv) = runtime().await;
    call(
        &inv,
        "ui.show_area",
        json!({"area": "settings", "item": "trading.commission"}),
    )
    .await;
    assert_eq!(state.settings.string("ui.area"), "settings");
    assert_eq!(
        state.settings.value("ui.view").unwrap()["settings"],
        "trading.commission"
    );
    call(
        &inv,
        "ui.show_area",
        json!({"area": "research", "item": "st-1"}),
    )
    .await;
    call(
        &inv,
        "ui.show_area",
        json!({"area": "journal", "journal": {"section": "reports", "reportTab": "breakdowns", "groupBy": "setup", "range": "30d"}}),
    )
    .await;
    let view = state.settings.value("ui.view").unwrap();
    assert_eq!(
        view["settings"], "trading.commission",
        "other areas keep theirs"
    );
    assert_eq!(view["research"], "st-1");
    assert_eq!(view["journal"]["section"], "reports");
    assert_eq!(view["journal"]["groupBy"], "setup");
    assert_eq!(view["journal"]["range"], "30d");
    call(
        &inv,
        "ui.show_area",
        json!({"area": "journal", "journal": {"tradeId": "T-7"}}),
    )
    .await;
    let j = state.settings.value("ui.view").unwrap()["journal"].clone();
    assert_eq!(j["tradeId"], "T-7");
    assert_eq!(j["section"], "trades");
    assert_eq!(j["groupBy"], "setup");
    call(
        &inv,
        "ui.show_area",
        json!({"area": "journal", "journal": {"section": "trades", "filter": {"outcome": "loss"}}}),
    )
    .await;
    let j = state.settings.value("ui.view").unwrap()["journal"].clone();
    assert_eq!(j["tradeId"], Value::Null);
    assert_eq!(j["filter"], json!({"outcome": "loss"}));
    for bad in [
        json!({"area": "settings", "item": "nowhere"}),
        json!({"area": "desk", "item": "chart-1"}),
        json!({"area": "journal", "item": "T-1"}),
        json!({"area": "agents", "journal": {"section": "days"}}),
        json!({"area": "journal", "journal": {"date": "yesterday"}}),
        json!({"area": "journal", "journal": {"section": "nowhere"}}),
    ] {
        refused(&inv, "ui.show_area", bad).await;
    }
}

#[tokio::test]
async fn the_agent_opens_markets_where_it_says() {
    let (_rt, state, inv) = runtime().await;
    let out = call(&inv, "ui.show_area", json!({"area": "markets"})).await;
    assert_eq!(out, json!({"area": "markets", "previous": "desk"}));
    assert_eq!(state.settings.string("ui.area"), "markets");
    call(
        &inv,
        "ui.show_area",
        json!({"area": "markets", "markets": {"list": "futures", "moving": true, "query": "nq", "connection": "mock"}}),
    )
    .await;
    let m = state.settings.value("ui.view").unwrap()["markets"].clone();
    assert_eq!(
        m,
        json!({"list": "futures", "moving": true, "query": "nq", "connection": "mock"})
    );
    call(
        &inv,
        "ui.show_area",
        json!({"area": "markets", "item": "NQ", "markets": {"instrument": "ES", "query": ""}}),
    )
    .await;
    let m = state.settings.value("ui.view").unwrap()["markets"].clone();
    assert_eq!(m["instrument"], "NQ");
    assert_eq!(m["query"], Value::Null, "\"\" clears");
    assert_eq!(m["list"], "futures");
    assert_eq!(m["moving"], true);
    call(
        &inv,
        "ui.show_area",
        json!({"area": "markets", "markets": {"watchlist": "main", "connection": ""}}),
    )
    .await;
    let m = state.settings.value("ui.view").unwrap()["markets"].clone();
    assert_eq!(m["list"], "watchlist");
    assert_eq!(m["watchlist"], "main");
    assert_eq!(m["connection"], Value::Null);
    let (code, msg) = refused(
        &inv,
        "ui.show_area",
        json!({"area": "markets", "markets": {"watchlist": "nope"}}),
    )
    .await;
    assert_eq!(code, ToolErrorCode::NotFound);
    assert!(msg.contains("main"), "the ids are listed: {msg}");
    let (_, msg) = refused(
        &inv,
        "ui.show_area",
        json!({"area": "desk", "markets": {"list": "all"}}),
    )
    .await;
    assert_eq!(msg, "`markets` goes with area markets");
    let (_, msg) = refused(
        &inv,
        "ui.show_area",
        json!({"area": "markets", "journal": {"section": "days"}}),
    )
    .await;
    assert_eq!(msg, "`journal` goes with area journal");
    for bad in [
        json!({"area": "markets", "markets": {"list": "bonds"}}),
        json!({"area": "markets", "markets": {"sort": "pct"}}),
    ] {
        refused(&inv, "ui.show_area", bad).await;
    }
    assert_eq!(
        state.settings.value("ui.view").unwrap()["markets"]["watchlist"],
        "main"
    );
    for bad in [
        json!({"area": "markets", "markets": {"setup": "rithmic-apex"}}),
        json!({"area": "markets", "markets": {"list": "connections"}}),
        json!({"area": "markets", "markets": {"list": "routes"}}),
        json!({"area": "settings", "item": "keyboard"}),
        json!({"area": "settings", "item": "credentials"}),
        json!({"area": "settings", "item": "themes"}),
        json!({"area": "settings", "item": "connectionsx"}),
    ] {
        refused(&inv, "ui.show_area", bad).await;
    }
    for place in [
        "connections",
        "connections.rithmic-apex",
        "connections.add.rithmic",
        "connections.add.spec",
        "connections.exchanges",
        "trading",
        "chart",
        "alerts",
        "analyst",
        "data",
        "appearance",
        "appearance.pick",
        "app",
    ] {
        call(
            &inv,
            "ui.show_area",
            json!({"area": "settings", "item": place}),
        )
        .await;
        assert_eq!(
            state.settings.value("ui.view").unwrap()["settings"],
            place,
            "{place}"
        );
    }
}

#[tokio::test]
async fn link_all_charts_joins_every_chart_to_one_group() {
    let (_rt, state, inv) = runtime().await;
    let qqq = state.layouts.get(None).unwrap().charts["chart-1"]
        .instrument
        .clone();
    call(
        &inv,
        "chart.set_link",
        json!({"tileId": "chart-1", "link": "1", "all": true}),
    )
    .await;
    let l = state.layouts.get(None).unwrap();
    assert!(
        l.charts
            .values()
            .all(|c| c.link_group.as_deref() == Some("1"))
    );
    assert!(l.charts.values().all(|c| c.instrument == qqq));
    call(&inv, "chart.set_link", json!({"all": true})).await;
    assert!(
        state
            .layouts
            .get(None)
            .unwrap()
            .charts
            .values()
            .all(|c| c.link_group.is_none())
    );
}

#[tokio::test]
async fn sharing_the_interval_moves_every_chart() {
    let (_rt, state, inv) = runtime().await;
    call(
        &inv,
        "chart.set_timeframe",
        json!({"tileId": "chart-1", "tf": "15m"}),
    )
    .await;
    assert_ne!(
        state.layouts.get(None).unwrap().charts["chart-2"]
            .timeframe
            .to_string(),
        "15m"
    );
    call(
        &inv,
        "layout.save",
        json!({"dock": {"tessera": {"v": 3, "syncInterval": true}}}),
    )
    .await;
    call(
        &inv,
        "chart.set_timeframe",
        json!({"tileId": "chart-1", "tf": "1h"}),
    )
    .await;
    assert!(
        state
            .layouts
            .get(None)
            .unwrap()
            .charts
            .values()
            .all(|c| c.timeframe.to_string() == "1h")
    );
}

#[tokio::test]
async fn removing_all_drawings_spares_the_users_unless_asked() {
    let (_rt, _state, inv) = runtime().await;
    let user = Origin::User;
    for origin in [user.clone(), agent()] {
        let r = invoke(
            &inv,
            "chart.add_drawing",
            json!({"kind": "horizontal_line", "points": [{"price": 400}]}),
            origin,
        )
        .await;
        assert!(r.ok, "{r:?}");
    }
    let gone = call(&inv, "chart.remove_drawing", json!({"all": true})).await;
    assert_eq!(gone["removed"], 1, "only the agent's");
    refused(
        &inv,
        "chart.remove_drawing",
        json!({"drawingId": "d-1", "includeUser": true}),
    )
    .await;
    let gone = call(
        &inv,
        "chart.remove_drawing",
        json!({"all": true, "includeUser": true}),
    )
    .await;
    assert_eq!(gone["removed"], 1, "the user's too");
}

#[tokio::test]
async fn the_order_flow_template_replaces_the_charts_indicators() {
    let (_rt, _state, inv) = runtime().await;
    let applied = call(
        &inv,
        "chart.apply_template",
        json!({"tileId": "chart-2", "template": "Order flow"}),
    )
    .await;
    let kinds: Vec<&str> = applied["chart"]["layers"]
        .as_array()
        .unwrap()
        .iter()
        .map(|l| l["kind"].as_str().unwrap())
        .collect();
    for k in ["footprint", "volume_profile", "big_trades", "delta"] {
        assert!(kinds.contains(&k), "{k} in {kinds:?}");
    }
    assert!(
        !kinds.contains(&"vwap"),
        "its indicators replace the chart's"
    );
}

#[tokio::test]
async fn the_preferences_change_field_by_field() {
    let (_rt, state, inv) = runtime().await;
    call(
        &inv,
        "settings.set",
        json!({"key": "ui.preferences", "value": {"favouriteIntervals": ["1m", "1h"], "watchlist": ["NQ"]}}),
    )
    .await;
    call(
        &inv,
        "settings.set",
        json!({"key": "ui.preferences", "value": {"recentSymbols": ["ES", "NQ"]}}),
    )
    .await;
    let prefs = state.settings.value("ui.preferences").unwrap();
    assert_eq!(prefs["favouriteIntervals"], json!(["1m", "1h"]));
    assert_eq!(prefs["recentSymbols"], json!(["ES", "NQ"]));
    call(
        &inv,
        "settings.set",
        json!({"key": "ui.preferences", "value": {"watchlist": null}}),
    )
    .await;
    assert!(
        state
            .settings
            .value("ui.preferences")
            .unwrap()
            .get("watchlist")
            .is_none()
    );
}

#[tokio::test]
async fn the_agent_reads_its_sessions_and_never_controls_them() {
    let (_rt, state, inv) = runtime().await;
    let now = tessera_core::Timestamp(1_760_000_000_000_000_000);
    let summary = AgentSessionSummary {
        id: SessionId::new("S-earlier"),
        title: "Gamma reversion on NQ".into(),
        preset: "Trader".into(),
        provider: "codex".into(),
        model: None,
        effort: None,
        thread: None,
        mode: SessionMode::AutoModify,
        status: AgentSessionStatus::Idle,
        origin: agent(),
        source_label: None,
        created_at: now,
        updated_at: now,
        queue: Vec::new(),
        queue_held: false,
    };
    state.store.sessions().upsert(&summary).unwrap();
    let events = [
        AgentEvent::UserMessage {
            text: "Does NQ revert after touching the zero gamma level?".into(),
            attachments: Vec::new(),
        },
        AgentEvent::AssistantDelta {
            message_id: "m1".into(),
            text: "Partly".into(),
        },
        AgentEvent::AssistantMessage {
            message_id: "m1".into(),
            text: "Measured: 58% reverted within 30 minutes.".into(),
            blocks: Vec::new(),
        },
    ];
    for (i, event) in events.into_iter().enumerate() {
        state
            .store
            .agent_events()
            .append(&AgentEventEnvelope {
                session_id: summary.id.clone(),
                seq: i as u64 + 1,
                ts: now,
                turn_id: Some("t1".into()),
                event,
            })
            .unwrap();
    }
    let list = call(&inv, "agent.list_sessions", json!({})).await;
    assert_eq!(list["sessions"][0]["title"], "Gamma reversion on NQ");
    let t = call(
        &inv,
        "agent.get_transcript",
        json!({"sessionId": "S-earlier", "limit": 1}),
    )
    .await;
    assert_eq!(t["entries"].as_array().unwrap().len(), 1);
    assert_eq!(t["entries"][0]["role"], "user");
    assert_eq!(t["more"], true);
    let next = call(
        &inv,
        "agent.get_transcript",
        json!({"sessionId": "S-earlier", "afterSeq": t["lastSeq"]}),
    )
    .await;
    let roles: Vec<&str> = next["entries"]
        .as_array()
        .unwrap()
        .iter()
        .map(|e| e["role"].as_str().unwrap())
        .collect();
    assert_eq!(roles, ["assistant"], "streaming is left out");
    assert_eq!(next["more"], false);
    let hits = call(
        &inv,
        "agent.search_sessions",
        json!({"query": "zero gamma"}),
    )
    .await;
    assert_eq!(hits["hits"][0]["sessionId"], "S-earlier");
    assert_eq!(hits["hits"][0]["title"], "Gamma reversion on NQ");
    assert_eq!(hits["hits"][0]["seq"], 1);
    refused(&inv, "agent.get_transcript", json!({"sessionId": "S-none"})).await;

    for (tool, input) in [
        ("agent.start_session", json!({"preset": "Trader"})),
        (
            "agent.send",
            json!({"sessionId": "S-earlier", "text": "go on"}),
        ),
        ("agent.interrupt", json!({"sessionId": "S-earlier"})),
        (
            "agent.edit_queued",
            json!({"sessionId": "S-earlier", "queuedId": "q1", "text": "go on"}),
        ),
        (
            "agent.remove_queued",
            json!({"sessionId": "S-earlier", "queuedId": "q1"}),
        ),
        ("agent.resume_queue", json!({"sessionId": "S-earlier"})),
        ("agent.delete_session", json!({"sessionId": "S-earlier"})),
    ] {
        let (code, msg) = refused(&inv, tool, input).await;
        assert_eq!(code, ToolErrorCode::PermissionDenied, "{tool}: {msg}");
    }
}

#[tokio::test]
async fn the_analyst_labels_lines_and_uses_drawing_templates_as_the_style_bar_does() {
    let (_rt, state, inv) = runtime().await;
    let d = call(
        &inv,
        "chart.add_drawing",
        json!({"kind": "horizontal_line", "points": [{"t": null, "price": 487.5}],
            "label": {"text": "PDH", "color": "brass", "size": 14, "bold": true, "italic": true,
                "align": "left", "position": "on", "showPrice": true}}),
    )
    .await;
    let id = d["drawing"]["id"].as_str().unwrap().to_owned();
    let up = call(
        &inv,
        "chart.update_drawing",
        json!({"drawingId": id, "label": {"text": "PDH\nswept at the open"}}),
    )
    .await;
    assert_eq!(up["drawing"]["label"]["text"], "PDH\nswept at the open");
    assert_eq!(up["drawing"]["label"]["position"], "on");
    call(
        &inv,
        "chart.save_drawing_template",
        json!({"name": "Prior day", "drawingId": id, "newDrawings": true}),
    )
    .await;
    let tools = state.settings.value("chart.drawingTools").unwrap();
    assert_eq!(tools["styles"]["horizontal_line"]["label"]["bold"], true);
    call(
        &inv,
        "chart.apply_drawing_template",
        json!({"drawingId": id, "template": "built-in"}),
    )
    .await;
    call(
        &inv,
        "chart.apply_drawing_template",
        json!({"drawingId": id, "template": "Prior day"}),
    )
    .await;
    call(
        &inv,
        "chart.set_default_drawing_template",
        json!({"kind": "horizontal_line"}),
    )
    .await;
    call(
        &inv,
        "chart.rename_drawing_template",
        json!({"template": "Prior day", "name": "Prior session"}),
    )
    .await;
    let left = call(
        &inv,
        "chart.delete_drawing_template",
        json!({"template": "Prior session"}),
    )
    .await;
    assert_eq!(left["templates"], json!([]));
    call(
        &inv,
        "settings.set",
        json!({"key": "chart.drawingTools", "value": {"styles": {"trend_line": {"color": "teal",
            "label": {"text": "", "size": 12, "position": "below", "showPrice": false}}}}}),
    )
    .await;
    let state_now = call(&inv, "chart.get_state", json!({})).await;
    let kept = state_now["chart"]["drawings"]
        .as_array()
        .unwrap()
        .iter()
        .find(|d| d["id"] == id.as_str())
        .unwrap()
        .clone();
    assert_eq!(
        kept["label"]["text"], "PDH\nswept at the open",
        "its words stay its own"
    );
    assert_eq!(kept["label"]["color"], "brass");
}
