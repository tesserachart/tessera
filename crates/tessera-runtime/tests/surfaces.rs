use std::sync::Arc;

use serde_json::{Value, json};
use tessera_core::Origin;
use tessera_core::ids::SessionId;
use tessera_protocol::tools::{SessionMode, ToolErrorCode, ToolOutcome};
use tessera_runtime::layout::{dock_requests, tile_requests};
use tessera_runtime::settings::SETTINGS;
use tessera_runtime::state::SharedState;
use tessera_runtime::{Runtime, RuntimeConfig};
use tessera_testkit::Fakes;
use tessera_tools::{InvokeRequest, Invoker, SessionPolicy};

mod common;

const USER_ONLY: [(&str, &str); 19] = [
    (
        "agent.maxStepsPerTurn",
        "the analyst's own loop guard: it must never be able to loosen it",
    ),
    (
        "agent.maxToolCallsPerTurn",
        "the analyst's own loop guard: it must never be able to loosen it",
    ),
    (
        "agent.dedupWindowMs",
        "the analyst's own loop guard: it must never be able to loosen it",
    ),
    (
        "agent.customInstructions",
        "the analyst's standing brief: rewritten by an agent, a prompt injection would persist across sessions",
    ),
    (
        "agent.defaultMode",
        "the mode new sessions start in: an agent must never widen the permissions of the sessions after it",
    ),
    (
        "agent.providers",
        "which of the user's own CLIs Tessera runs, and how: an agent must never turn one on or give it a shell by its \
         launch arguments",
    ),
    (
        "agent.sessionRunner",
        "the analyst trading an account on its own in full access: only the user starts it, picks the account and \
         names the file its instructions come from",
    ),
    (
        "approvals.staleAfterSeconds",
        "how long an order draft the user approves stays valid: an approval rule",
    ),
    (
        "approvals.staleAfterTicks",
        "how many trades an order draft the user approves outlives: an approval rule",
    ),
    (
        "paper.commissionStandard",
        "what a paper order costs: it changes what an order risks and what its P&L reads",
    ),
    (
        "paper.commissionMicro",
        "what a paper order costs: it changes what an order risks and what its P&L reads",
    ),
    (
        "market.dataSource",
        "where market data comes from decides what is charted and so what is traded (decision 0010)",
    ),
    (
        "market.dataByExchange",
        "where each exchange's market data comes from decides what is charted and so what is traded (decision 0010)",
    ),
    (
        "trade.accountByExchange",
        "the account a Trade panel sends an exchange's orders to: where an order goes",
    ),
    (
        "trade.positionBracket",
        "what Tessera sends by itself to keep a position's stop and target: what a position risks (decision 0015)",
    ),
    (
        "accounts.types",
        "what kind each account is decides its safety cues and whether a firm's rules apply: an agent must not relabel a live or funded account",
    ),
    (
        "risk.limits",
        "the trader's own risk limits, what every order is held to: an agent must never loosen them (decision 0014)",
    ),
    (
        "sounds",
        "a fill or a stop hit the trader trades by ear must never go quiet behind their back",
    ),
    (
        "telemetry.consent",
        "the user's consent to crash reports and usage analytics: only the user gives or withdraws it",
    ),
];

fn agent() -> Origin {
    Origin::Agent {
        session_id: SessionId::new("S-surfaces"),
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

async fn call(inv: &Invoker, name: &str, input: Value) -> Value {
    common::call(inv, &agent(), name, input).await
}

async fn refused(inv: &Invoker, name: &str, input: Value) -> (ToolErrorCode, String) {
    let r = inv
        .invoke(InvokeRequest::new(name, input.clone(), agent()))
        .await;
    assert!(!r.ok, "{name} {input} should be refused: {r:?}");
    let e = r.error.unwrap();
    (e.code, e.message)
}

#[tokio::test]
async fn every_setting_is_the_agents_unless_it_is_the_users_own() {
    let (_rt, state, inv) = runtime().await;
    let mut declared: Vec<&str> = SETTINGS
        .iter()
        .filter(|d| d.user_only)
        .map(|d| d.key)
        .collect();
    let mut listed: Vec<&str> = USER_ONLY.iter().map(|(k, _)| *k).collect();
    declared.sort_unstable();
    listed.sort_unstable();
    assert_eq!(
        declared, listed,
        "a user-only setting is listed here with its reason, and only those"
    );
    for (key, why) in USER_ONLY {
        assert!(!why.is_empty(), "{key}");
    }
    for d in SETTINGS {
        inv.begin_turn(&agent());
        let value = (d.default)();
        let r = inv
            .invoke(InvokeRequest::new(
                "settings.set",
                json!({"key": d.key, "value": value}),
                agent(),
            ))
            .await;
        if d.user_only {
            assert!(!r.ok, "{} is the user's alone", d.key);
            assert_eq!(
                r.error.map(|e| e.code),
                Some(ToolErrorCode::PermissionDenied),
                "{}",
                d.key
            );
        } else {
            assert!(
                r.ok,
                "an Auto-modify agent sets {} back to its default: {r:?}",
                d.key
            );
            let stored_as = if d.key == tessera_protocol::chart_theme::KEY {
                tessera_protocol::theme::KEY
            } else {
                d.key
            };
            assert!(state.settings.stored(stored_as).is_some(), "{}", d.key);
        }
    }
}

#[tokio::test]
async fn the_agent_shows_an_area_and_a_workspace() {
    let (_rt, state, inv) = runtime().await;
    assert_eq!(state.settings.string("ui.area"), "desk");
    let out = call(&inv, "ui.show_area", json!({"area": "journal"})).await;
    assert_eq!(out, json!({"area": "journal", "previous": "desk"}));
    assert_eq!(state.settings.string("ui.area"), "journal");
    let out = call(&inv, "ui.show_area", json!({"area": "settings"})).await;
    assert_eq!(out, json!({"area": "settings", "previous": "journal"}));
    assert_eq!(state.settings.string("ui.area"), "settings");
    let (code, _) = refused(&inv, "ui.show_area", json!({"area": "trading"})).await;
    assert_eq!(code, ToolErrorCode::InvalidInput);
    let (code, msg) = refused(&inv, "ui.show_area", json!({"area": "profile"})).await;
    assert_eq!(code, ToolErrorCode::Unavailable, "{msg}");
    assert_eq!(state.settings.string("ui.area"), "settings");
    let supervised = Origin::Agent {
        session_id: SessionId::new("S-supervised"),
        provider: "codex".into(),
    };
    inv.set_policy(
        &supervised,
        SessionPolicy::with_mode(SessionMode::Supervised),
    );
    let r = inv
        .invoke(InvokeRequest::new(
            "ui.show_area",
            json!({"area": "research"}),
            supervised,
        ))
        .await;
    assert_eq!(r.status, ToolOutcome::PendingApproval, "{r:?}");
    assert_eq!(state.settings.string("ui.area"), "settings");

    let (code, msg) = refused(&inv, "ui.show_workspace", json!({"layoutId": "nope"})).await;
    assert_eq!(code, ToolErrorCode::NotFound, "{msg}");
    call(
        &inv,
        "layout.save",
        json!({"layoutId": "ws-scalp", "name": "Scalp"}),
    )
    .await;
    let out = call(&inv, "ui.show_workspace", json!({"layoutId": "ws-scalp"})).await;
    assert_eq!(out, json!({"layoutId": "ws-scalp", "previous": null}));
    assert_eq!(state.settings.string("ui.workspace"), "ws-scalp");
    assert_eq!(state.settings.string("ui.area"), "desk");
}

#[tokio::test]
async fn the_agent_opens_every_kind_of_tile() {
    let (_rt, state, inv) = runtime().await;
    for kind in ["trade", "analyst", "positions", "accounts", "dom", "tape"] {
        let out = call(&inv, "workspace.open_tile", json!({"kind": kind})).await;
        assert_eq!(out["request"]["kind"], kind);
    }
    let out = call(&inv, "workspace.open_tile", json!({"kind": "markets"})).await;
    assert_eq!(out["request"]["id"], "area-markets");
    assert_eq!(state.settings.string("ui.area"), "markets");
    assert_eq!(
        tile_requests(&state.layouts.get(None).unwrap().dock).len(),
        6
    );
    let out = call(
        &inv,
        "workspace.open_tile",
        json!({"kind": "chart", "instrument": "NQ"}),
    )
    .await;
    let nq = out["request"]["params"]["instrument"].as_str().unwrap();
    assert!(nq.starts_with("NQ") && nq.len() > 2, "resolved: {nq}");
    let open = tile_requests(&state.layouts.get(None).unwrap().dock);
    assert_eq!(open.len(), 7);
    assert_eq!(open[6].kind.as_str(), "chart");
    for bad in [
        json!({"kind": "trade", "instrument": "NQ"}),
        json!({"kind": "analyst", "instrument": "NQ"}),
        json!({"kind": "markets", "link": "1"}),
        json!({"kind": "chart", "link": "1"}),
    ] {
        let (code, msg) = refused(&inv, "workspace.open_tile", bad.clone()).await;
        assert_eq!(code, ToolErrorCode::InvalidInput, "{bad}: {msg}");
        if bad["kind"] == "markets" {
            assert!(
                msg.starts_with("Markets is an area now: ui.show_area {area: markets}"),
                "{msg}"
            );
        }
    }
    let out = call(
        &inv,
        "workspace.open_tile",
        json!({"kind": "chart", "placement": "tab", "beside": "chart-1"}),
    )
    .await;
    assert_eq!(out["request"]["params"]["placement"], "tab");
    assert_eq!(out["request"]["params"]["beside"], "chart-1");
    let out = call(&inv, "workspace.open_tile", json!({"kind": "chart"})).await;
    let params = out["request"]["params"].as_object().unwrap();
    assert!(!params.contains_key("placement") && !params.contains_key("beside"));
    let (code, msg) = refused(
        &inv,
        "workspace.open_tile",
        json!({"kind": "chart", "placement": "tab", "beside": "chart-9"}),
    )
    .await;
    assert_eq!(code, ToolErrorCode::NotFound, "{msg}");
    let (code, msg) = refused(
        &inv,
        "workspace.open_tile",
        json!({"kind": "dom", "placement": "tab"}),
    )
    .await;
    assert_eq!(code, ToolErrorCode::InvalidInput, "{msg}");
    let mut charts = state.layouts.get(None).unwrap().charts;
    let one = charts["chart-1"].clone();
    for n in 3..=21 {
        let id = format!("chart-{n}");
        charts.insert(
            id.clone(),
            tessera_protocol::layout::ChartState {
                tile_id: id.clone(),
                title: id,
                ..one.clone()
            },
        );
    }
    call(&inv, "layout.save", json!({"charts": charts})).await;
    let (code, msg) = refused(
        &inv,
        "workspace.open_tile",
        json!({"kind": "chart", "placement": "split"}),
    )
    .await;
    assert_eq!(code, ToolErrorCode::InvalidInput);
    assert!(msg.contains("24 charts"), "{msg}");
}

fn desk_dock() -> Value {
    json!({
        "grid": {"root": {"type": "branch", "data": [
            {"type": "leaf", "data": {"views": ["chart-1"], "activeView": "chart-1", "id": "g1"}},
            {"type": "leaf", "data": {"views": ["chart-2", "dom"], "activeView": "dom", "id": "g2"}},
        ]}, "width": 1200, "height": 800, "orientation": "HORIZONTAL"},
        "panels": {
            "chart-1": {"id": "chart-1", "contentComponent": "chart", "title": "Chart 1", "params": {"layoutId": "default", "tileId": "chart-1"}},
            "chart-2": {"id": "chart-2", "contentComponent": "chart", "title": "Chart 2", "params": {"layoutId": "default", "tileId": "chart-2"}},
            "dom": {"id": "dom", "contentComponent": "dom", "title": "DOM", "params": {"link": "1"}},
            "markets": {"id": "markets", "contentComponent": "markets", "title": "Markets", "params": {"link": "1"}},
            "trade": {"id": "trade", "contentComponent": "trade", "title": "Trade"},
            "analyst": {"id": "analyst", "contentComponent": "analyst", "title": "Analyst"},
            "positions": {"id": "positions", "contentComponent": "positions", "title": "Positions"},
            "accounts": {"id": "accounts", "contentComponent": "accounts", "title": "Accounts"},
        },
        "edgeGroups": {
            "left": {"size": 280, "visible": true, "collapsed": true, "group": {"views": ["markets"], "activeView": "markets", "id": "e-left"}},
            "right": {"size": 392, "visible": true, "group": {"views": ["trade", "analyst"], "activeView": "trade", "id": "edge-right"}},
            "bottom": {"size": 192, "visible": true, "group": {"views": ["positions", "accounts"], "activeView": "positions", "id": "e-bottom"}},
        },
        "tessera": {"v": 3, "preset": "2h", "collapsed": {"left": true}},
    })
}

#[tokio::test]
async fn the_agent_closes_shows_arranges_and_sets_tiles_through_the_dock() {
    let (_rt, state, inv) = runtime().await;
    call(&inv, "layout.save", json!({"dock": desk_dock()})).await;

    let tiles = call(&inv, "workspace.list_tiles", json!({})).await;
    let brief: Vec<(String, String, String, bool)> = tiles["tiles"]
        .as_array()
        .unwrap()
        .iter()
        .map(|t| {
            (
                t["tileId"].as_str().unwrap().to_owned(),
                t["kind"].as_str().unwrap().to_owned(),
                t["place"].as_str().unwrap().to_owned(),
                t["visible"].as_bool().unwrap(),
            )
        })
        .collect();
    let groups: Vec<Option<&str>> = tiles["tiles"]
        .as_array()
        .unwrap()
        .iter()
        .take(3)
        .map(|t| t["group"].as_str())
        .collect();
    assert_eq!(groups, [Some("g1"), Some("g2"), Some("g2")]);
    let want = [
        ("chart-1", "chart", "centre", true),
        ("chart-2", "chart", "centre", false),
        ("dom", "dom", "centre", true),
        ("markets", "markets", "left", false),
        ("trade", "trade", "right", true),
        ("analyst", "analyst", "right", false),
        ("positions", "positions", "bottom", true),
        ("accounts", "accounts", "bottom", false),
    ];
    assert_eq!(
        brief,
        want.map(|(a, b, c, d)| (a.to_owned(), b.to_owned(), c.to_owned(), d))
    );
    assert_eq!(tiles["collapsed"], json!(["left"]));

    let closed = call(&inv, "workspace.close_tile", json!({"tileId": "chart-2"})).await;
    assert_eq!(
        closed["request"],
        json!({"id": format!("op-{}", closed["revision"]), "op": "close", "tileId": "chart-2", "kind": "chart", "preset": null, "settings": null, "place": null})
    );
    let shown = call(&inv, "workspace.focus_tile", json!({"kind": "markets"})).await;
    assert_eq!(shown["request"]["id"], "area-markets");
    assert_eq!(shown["revision"], closed["revision"]);
    assert_eq!(state.settings.string("ui.area"), "markets");
    let trade = call(&inv, "workspace.focus_tile", json!({"kind": "trade"})).await;
    assert_eq!(trade["request"]["kind"], "trade");
    call(&inv, "workspace.focus_tile", json!({"tileId": "dom"})).await;
    let arranged = call(&inv, "workspace.apply_preset", json!({"preset": "4"})).await;
    assert_eq!(arranged["request"]["preset"], "4");
    call(&inv, "workspace.apply_preset", json!({"preset": "scalp"})).await;
    call(&inv, "workspace.apply_preset", json!({"preset": "reset"})).await;
    let set = call(
        &inv,
        "workspace.set_tile_settings",
        json!({"tileId": "dom", "settings": {"rowTicks": 4, "volumeColumn": "recent", "instrument": "NQ"}}),
    )
    .await;
    let settings = &set["request"]["settings"];
    assert_eq!(settings["rowTicks"], 4);
    assert!(
        settings["instrument"].as_str().unwrap().starts_with("NQ"),
        "resolved: {settings}"
    );
    call(
        &inv,
        "workspace.set_tile_settings",
        json!({"tileId": "positions", "settings": {"account": "all"}}),
    )
    .await;
    call(
        &inv,
        "workspace.open_tile",
        json!({"kind": "tape", "link": "1"}),
    )
    .await;
    let layout = state.layouts.get(None).unwrap();
    let ops = dock_requests(&layout.dock);
    let order: Vec<&str> = ops.iter().map(|r| r.id.as_str()).collect();
    assert_eq!(ops.len(), 8, "{order:?}");
    let revs: Vec<u64> = ops
        .iter()
        .map(|r| r.id.trim_start_matches("op-").parse().unwrap())
        .collect();
    assert!(revs.windows(2).all(|w| w[0] < w[1]), "{order:?}");
    let open = tile_requests(&layout.dock);
    assert_eq!(open.len(), 1);
    let open_rev: u64 = open[0].id.trim_start_matches("open-").parse().unwrap();
    assert!(open_rev > *revs.last().unwrap());
    assert_eq!(layout.dock["panels"], desk_dock()["panels"]);
    assert_eq!(layout.dock["tessera"]["preset"], "2h");

    for input in [json!({"tileId": "markets"}), json!({"kind": "markets"})] {
        let (code, msg) = refused(&inv, "workspace.close_tile", input.clone()).await;
        assert_eq!(code, ToolErrorCode::InvalidInput, "{input}");
        assert_eq!(msg, "Markets is an area now: ui.show_area {area: markets}");
    }
    for (tool, input) in [
        ("workspace.focus_tile", json!({"tileId": "markets"})),
        (
            "workspace.set_tile_settings",
            json!({"tileId": "markets", "settings": {"link": null}}),
        ),
        (
            "workspace.move_tile",
            json!({"kind": "markets", "to": "right"}),
        ),
        (
            "workspace.move_tile",
            json!({"tileId": "markets", "to": "right"}),
        ),
    ] {
        let (code, msg) = refused(&inv, tool, input.clone()).await;
        assert_eq!(code, ToolErrorCode::InvalidInput, "{tool} {input}");
        assert_eq!(msg, "Markets is an area now: ui.show_area {area: markets}");
    }
    for (tool, input, code) in [
        (
            "workspace.close_tile",
            json!({}),
            ToolErrorCode::InvalidInput,
        ),
        (
            "workspace.close_tile",
            json!({"tileId": "chart-1", "kind": "chart"}),
            ToolErrorCode::InvalidInput,
        ),
        (
            "workspace.close_tile",
            json!({"tileId": "nope"}),
            ToolErrorCode::NotFound,
        ),
        (
            "workspace.close_tile",
            json!({"kind": "tape"}),
            ToolErrorCode::NotFound,
        ),
        (
            "workspace.focus_tile",
            json!({"kind": "tape"}),
            ToolErrorCode::NotFound,
        ),
        (
            "workspace.apply_preset",
            json!({"preset": "5"}),
            ToolErrorCode::InvalidInput,
        ),
        (
            "workspace.set_tile_settings",
            json!({"tileId": "dom", "settings": {"rowTicks": 3}}),
            ToolErrorCode::InvalidInput,
        ),
        (
            "workspace.set_tile_settings",
            json!({"tileId": "chart-1", "settings": {"link": "1"}}),
            ToolErrorCode::InvalidInput,
        ),
        (
            "workspace.set_tile_settings",
            json!({"tileId": "analyst", "settings": {"link": "1"}}),
            ToolErrorCode::InvalidInput,
        ),
        (
            "workspace.set_tile_settings",
            json!({"tileId": "trade", "settings": {"qty": 2}}),
            ToolErrorCode::InvalidInput,
        ),
        (
            "workspace.set_tile_settings",
            json!({"tileId": "nope", "settings": {"link": "1"}}),
            ToolErrorCode::NotFound,
        ),
    ] {
        let (got, msg) = refused(&inv, tool, input.clone()).await;
        assert_eq!(got, code, "{tool} {input}: {msg}");
    }
    assert_eq!(
        dock_requests(&state.layouts.get(None).unwrap().dock).len(),
        8
    );

    let mut saved = desk_dock();
    saved["tessera"] = json!({"v": 3, "preset": "4", "collapsed": {}});
    call(&inv, "layout.save", json!({"dock": saved})).await;
    let layout = state.layouts.get(None).unwrap();
    assert!(dock_requests(&layout.dock).is_empty());
    assert!(tile_requests(&layout.dock).is_empty());

    let mut charts = layout.charts.clone();
    charts.remove("chart-2");
    call(&inv, "layout.save", json!({"charts": charts})).await;
    let last = call(&inv, "workspace.close_tile", json!({"kind": "chart"})).await;
    assert_eq!(last["request"]["op"], "close");
    call(&inv, "layout.save", json!({"charts": {}})).await;
    let emptied = state.layouts.get(None).unwrap();
    assert!(emptied.charts.is_empty());
    assert_eq!(emptied.active_chart_id, None);
}

#[tokio::test]
async fn a_chart_joins_a_link_group_and_takes_its_symbol() {
    let (_rt, state, inv) = runtime().await;
    let layout = state.layouts.get(None).unwrap();
    let qqq = layout.charts["chart-1"].instrument.clone();
    assert_ne!(layout.charts["chart-2"].instrument, qqq);
    call(
        &inv,
        "chart.set_link",
        json!({"tileId": "chart-1", "link": "2"}),
    )
    .await;
    let out = call(
        &inv,
        "chart.set_link",
        json!({"tileId": "chart-2", "link": "2"}),
    )
    .await;
    assert_eq!(out["chart"]["linkGroup"], "2");
    assert_eq!(
        out["chart"]["instrument"],
        qqq.as_str(),
        "the group's symbol"
    );
    call(
        &inv,
        "chart.set_symbol",
        json!({"tileId": "chart-1", "instrument": "SPY"}),
    )
    .await;
    let layout = state.layouts.get(None).unwrap();
    assert_eq!(
        layout.charts["chart-2"].instrument,
        layout.charts["chart-1"].instrument
    );
    let out = call(&inv, "chart.set_link", json!({"tileId": "chart-2"})).await;
    assert_eq!(out["chart"]["linkGroup"], Value::Null);
    assert_eq!(
        out["chart"]["instrument"],
        layout.charts["chart-1"].instrument.as_str()
    );
    let (code, _) = refused(&inv, "chart.set_link", json!({"link": "9"})).await;
    assert_eq!(code, ToolErrorCode::InvalidInput);
}

#[tokio::test]
async fn the_agent_moves_tiles_and_opens_or_collapses_the_edges() {
    let (_rt, state, inv) = runtime().await;
    call(&inv, "layout.save", json!({"dock": desk_dock()})).await;
    let moved = call(
        &inv,
        "workspace.move_tile",
        json!({"kind": "accounts", "to": "right"}),
    )
    .await;
    assert_eq!(moved["request"]["op"], "move");
    assert_eq!(moved["request"]["tileId"], Value::Null);
    assert_eq!(moved["request"]["kind"], "accounts");
    assert_eq!(moved["request"]["place"], "right");
    call(
        &inv,
        "workspace.move_tile",
        json!({"tileId": "dom", "to": "floating"}),
    )
    .await;
    let view = call(
        &inv,
        "workspace.set_view",
        json!({"left": true, "bottom": false, "shareInterval": true}),
    )
    .await;
    assert_eq!(view["request"]["op"], "view");
    assert_eq!(
        view["request"]["settings"],
        json!({"left": true, "bottom": false, "shareInterval": true})
    );
    assert_eq!(
        dock_requests(&state.layouts.get(None).unwrap().dock).len(),
        3
    );
    for (tool, input, code) in [
        (
            "workspace.move_tile",
            json!({"tileId": "dom", "to": "popout"}),
            ToolErrorCode::InvalidInput,
        ),
        (
            "workspace.move_tile",
            json!({"kind": "tape", "to": "left"}),
            ToolErrorCode::NotFound,
        ),
        (
            "workspace.move_tile",
            json!({"to": "left"}),
            ToolErrorCode::InvalidInput,
        ),
        ("workspace.set_view", json!({}), ToolErrorCode::InvalidInput),
        (
            "workspace.set_view",
            json!({"top": true}),
            ToolErrorCode::InvalidInput,
        ),
    ] {
        let (got, msg) = refused(&inv, tool, input.clone()).await;
        assert_eq!(got, code, "{tool} {input}: {msg}");
    }
}

#[tokio::test]
async fn a_workspaces_trade_setup_is_the_users_alone() {
    let (_rt, state, inv) = runtime().await;
    let trade = json!({"account": "paper-main", "qty": 5});
    let (code, msg) = refused(&inv, "layout.save", json!({"trade": trade})).await;
    assert_eq!(code, ToolErrorCode::PermissionDenied, "{msg}");
    let supervised = Origin::Agent {
        session_id: SessionId::new("S-supervised-trade"),
        provider: "codex".into(),
    };
    inv.set_policy(
        &supervised,
        SessionPolicy::with_mode(SessionMode::Supervised),
    );
    let r = inv
        .invoke(InvokeRequest::new(
            "layout.save",
            json!({"trade": trade}),
            supervised,
        ))
        .await;
    assert!(!r.ok && r.approval.is_none(), "{r:?}");
    assert_eq!(
        r.error.map(|e| e.code),
        Some(ToolErrorCode::PermissionDenied)
    );
    assert_eq!(state.layouts.get(None).unwrap().trade, Value::Null);
    call(&inv, "layout.save", json!({"name": "Day"})).await;
    let r = inv
        .invoke(InvokeRequest::new(
            "layout.save",
            json!({"trade": trade}),
            Origin::User,
        ))
        .await;
    assert!(r.ok, "{r:?}");
    assert_eq!(state.layouts.get(None).unwrap().trade, trade);
}
