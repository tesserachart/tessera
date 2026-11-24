use std::collections::BTreeSet;
use std::fmt::Write as _;
use std::sync::Arc;

use chrono::{TimeZone, Timelike};
use serde_json::{Value, json};
use tessera_core::clock::ManualClock;
use tessera_core::ids::SessionId;
use tessera_core::{Origin, Timeframe, Timestamp};
use tessera_market::{BarsRequest, MarketDataProvider};
use tessera_protocol::tools::SessionMode;
use tessera_runtime::{Runtime, RuntimeConfig};
use tessera_testkit::Fakes;
use tessera_tools::{InvokeRequest, SessionPolicy};

mod common;

use common::call;

fn ny(t: i64) -> chrono::DateTime<chrono_tz::Tz> {
    chrono_tz::America::New_York.timestamp_nanos(t)
}

const BELOW_THE_CALL_WALL: &str = r#"export function positions(bars) {
  const cw = bars.levels['acme-levels.CW'];
  const asOf = bars.levelsAsOf['acme-levels.CW'];
  return bars.close.map((close, i) => (bars.time[i] - asOf[i] < 3600 ? (close < cw[i] ? 1 : 0) : NaN));
}
"#;

#[tokio::test]
async fn an_unknown_vendors_file_is_previewed_mapped_dry_run_imported_studied_and_undone() {
    let dir = tempfile::tempdir().unwrap();
    let data = dir.path().join("data");
    let now = Timestamp::parse("2026-10-09T17:00:00-04:00").unwrap();
    let config = RuntimeConfig {
        data_dir: Some(data.clone()),
        clock: Arc::new(ManualClock::new(now)),
        ..RuntimeConfig::default()
    };
    let fakes = Fakes {
        gamma: false,
        ..Fakes::still(12)
    };
    let rt = Runtime::build(config, vec![fakes.module()]).await.unwrap();
    let inv = Arc::clone(&rt.state().invoker);
    let agent = Origin::Agent {
        session_id: SessionId::new("L1"),
        provider: "codex".into(),
    };
    inv.set_policy(&agent, SessionPolicy::with_mode(SessionMode::AutoModify));

    let none = call(
        &inv,
        &agent,
        "intel.get_level_history",
        json!({"instrument": "NQ"}),
    )
    .await;
    assert!(none["series"].as_array().unwrap().is_empty());
    let note = none["notes"][0].as_str().unwrap();
    assert!(note.contains("no source of levels is connected"), "{note}");

    let market = Arc::clone(rt.state().connections.market());
    let nq = market.resolve("NQ").await.unwrap();
    let bars = market
        .route_async(&nq)
        .await
        .unwrap()
        .get_bars(BarsRequest {
            instrument: nq.clone(),
            tf: Timeframe::M1,
            from: None,
            to: None,
            limit: None,
            rth_only: true,
        })
        .await
        .unwrap()
        .bars;
    let dates: Vec<String> = bars
        .iter()
        .map(|b| ny(b.t.0).format("%Y-%m-%d").to_string())
        .collect::<BTreeSet<_>>()
        .into_iter()
        .collect();
    let covered: Vec<&String> = dates[2..9].iter().collect();
    let mut csv = String::from("Time;Symbol;Kind;Price\n");
    let mut rows = 0;
    for b in &bars {
        let t = ny(b.t.0);
        if !covered.contains(&&t.format("%Y-%m-%d").to_string()) || !t.minute().is_multiple_of(5) {
            continue;
        }
        let close: f64 = b.c.0.to_string().parse().unwrap();
        let cw = (close / 25.0).ceil() * 25.0 + 25.0;
        let stamp = t.format("%m/%d/%Y %H:%M");
        writeln!(csv, "{stamp};NQ1!;CW;{cw:.2}").unwrap();
        writeln!(csv, "{stamp};NQ1!;PW;{:.2}", cw - 100.0).unwrap();
        rows += 2;
    }
    csv.push_str("not a time;NQ1!;CW;1\n");
    let path = data.join("acme-levels-export.csv");
    std::fs::write(&path, &csv).unwrap();
    let path = path.to_str().unwrap().to_owned();

    let p = call(&inv, &agent, "intel.preview_file", json!({"path": path})).await;
    assert_eq!(p["format"], "csv");
    assert_eq!(p["delimiter"], ";");
    assert_eq!(p["header"], json!(["Time", "Symbol", "Kind", "Price"]));
    assert_eq!(p["rows"].as_array().unwrap().len(), 20);
    assert_eq!(p["columns"][0]["kind"], "time");
    assert_eq!(p["columns"][0]["needsZone"], true);
    assert_eq!(p["columns"][3]["kind"], "number");
    assert!(
        p["adapters"].as_array().unwrap().is_empty(),
        "nobody knows Acme yet"
    );
    let r = inv
        .invoke(InvokeRequest::new(
            "intel.preview_file",
            json!({"path": "/etc/hostname"}),
            agent.clone(),
        ))
        .await;
    assert!(!r.ok);

    let mapping = json!({
        "vendor": "Acme Levels",
        "time": "Time",
        "timeFormat": "%m/%d/%Y %H:%M",
        "timeZone": "America/New_York",
        "instrument": "Symbol",
        "instruments": {"NQ1!": "NQ"},
        "level": "Kind",
        "value": "Price",
        "vocabulary": {"CW": {"label": "Call Wall"}, "PW": {"label": "Put Wall"}}
    });
    let dry = call(
        &inv,
        &agent,
        "intel.import_level_history",
        json!({"path": path, "adapter": {"kind": "mapping", "mapping": mapping}}),
    )
    .await;
    assert_eq!(dry["dryRun"], true);
    assert_eq!(dry["records"], rows);
    assert_eq!(dry["imported"], rows);
    assert_eq!(dry["unreadable"], 1);
    assert_eq!(dry["problems"][0]["line"], rows + 2);
    assert_eq!(dry["instruments"], json!(["NQ"]));
    assert_eq!(dry["days"], 7);
    assert_eq!(dry["firstDate"], covered[0].as_str());
    let names: Vec<&str> = dry["series"]
        .as_array()
        .unwrap()
        .iter()
        .map(|s| s["name"].as_str().unwrap())
        .collect();
    assert_eq!(names, ["acme-levels.CW", "acme-levels.PW"]);
    assert_eq!(dry["series"][0]["label"], "Call Wall");
    assert_eq!(dry["samples"].as_array().unwrap().len(), 8);
    let listed = call(&inv, &agent, "intel.list_level_history", json!({})).await;
    assert!(
        listed["series"].as_array().unwrap().is_empty(),
        "a dry run stores nothing"
    );

    let done = call(
        &inv,
        &agent,
        "intel.import_level_history",
        json!({"path": path, "adapter": {"kind": "mapping", "mapping": mapping}, "dryRun": false, "save": true}),
    )
    .await;
    assert_eq!(done["imported"], rows);
    assert_eq!(done["saved"], "acme-levels");
    let import_id = done["importId"].as_str().unwrap().to_owned();
    let listed = call(&inv, &agent, "intel.list_level_history", json!({})).await;
    assert_eq!(listed["series"].as_array().unwrap().len(), 2);
    assert_eq!(listed["series"][0]["vendor"], "Acme Levels");
    assert_eq!(listed["series"][0]["days"], 7);
    assert_eq!(listed["series"][0]["origins"]["import"], rows / 2);
    assert!(
        listed["adapters"]
            .as_array()
            .unwrap()
            .iter()
            .any(|a| a["name"] == "acme-levels" && a["kind"] == "mapping")
    );
    let again = call(
        &inv,
        &agent,
        "intel.import_level_history",
        json!({"path": path, "adapter": {"kind": "saved", "vendor": "Acme Levels"}}),
    )
    .await;
    assert_eq!(again["imported"], 0);
    assert_eq!(again["duplicates"], rows);
    let p = call(&inv, &agent, "intel.preview_file", json!({"path": path})).await;
    assert_eq!(p["adapters"][0]["name"], "acme-levels");

    let hist = call(
        &inv,
        &agent,
        "intel.get_level_history",
        json!({"instrument": "NQ", "levels": ["acme-levels.CW"], "limit": 10}),
    )
    .await;
    assert_eq!(hist["series"].as_array().unwrap().len(), 1);
    assert_eq!(hist["series"][0]["truncated"], true);
    assert_eq!(hist["series"][0]["observations"][0]["origin"], "import");

    let study = |name: &str, strategy: Value| {
        json!({
            "name": name,
            "hypothesis": "Under Acme's call wall NQ drifts up toward it in the first two hours of the cash session.",
            "data": {
                "instrument": "NQ",
                "tf": "1m",
                "rthOnly": true,
                "levels": ["acme-levels.CW"],
                "window": {"start": "09:30", "end": "11:30"}
            },
            "strategy": strategy,
            "gates": {"minTrades": 5},
            "placeboRuns": 0
        })
    };
    let rules = call(
        &inv,
        &agent,
        "research.save_study",
        study(
            "rules over the covered sessions",
            json!({"kind": "rules", "rule": {"rule": "ema_cross", "fast": 9, "slow": 21}}),
        ),
    )
    .await;
    let run = call(
        &inv,
        &agent,
        "research.run_study",
        json!({"id": rules["id"]}),
    )
    .await;
    assert_eq!(run["levels"]["sessionsUsed"], 7);
    assert_eq!(run["levels"]["sessionsRead"], dates.len());
    assert_eq!(run["levels"]["inputs"][0]["series"], "acme-levels.CW");
    assert_eq!(run["sessions"], 7);

    let script = call(
        &inv,
        &agent,
        "research.save_study",
        study(
            "long under the call wall",
            json!({"kind": "script", "code": BELOW_THE_CALL_WALL}),
        ),
    )
    .await;
    let out = call(
        &inv,
        &agent,
        "research.run_study",
        json!({"id": script["id"]}),
    )
    .await;
    assert_eq!(out["levels"]["sessionsUsed"], 7, "{out}");
    let full = call(
        &inv,
        &agent,
        "research.get_run",
        json!({"runId": out["runId"]}),
    )
    .await;
    let trades = full["evaluation"]["cases"][0]["trades"].as_array().unwrap();
    assert!(!trades.is_empty());
    for t in trades {
        let entry = ny(t["entryTime"].as_i64().unwrap());
        let m = entry.hour() * 60 + entry.minute();
        assert!((570..690).contains(&m), "entry at {entry}");
    }

    let other = call(
        &inv,
        &agent,
        "research.save_study",
        json!({
            "name": "max long gamma",
            "hypothesis": "h",
            "data": {"instrument": "NQ", "tf": "1m", "levels": ["acme.major_long_gamma"]},
            "strategy": {"kind": "rules", "rule": {"rule": "ema_cross", "fast": 9, "slow": 21}}
        }),
    )
    .await;
    let r = inv
        .invoke(InvokeRequest::new(
            "research.run_study",
            json!({"id": other["id"]}),
            agent.clone(),
        ))
        .await;
    let msg = r.error.unwrap().message;
    assert!(
        msg.contains("no level history of acme.major_long_gamma"),
        "{msg}"
    );

    let undone = call(
        &inv,
        &agent,
        "intel.undo_level_import",
        json!({"importId": import_id}),
    )
    .await;
    assert_eq!(undone["removed"], rows);
    let listed = call(&inv, &agent, "intel.list_level_history", json!({})).await;
    assert!(listed["series"].as_array().unwrap().is_empty());
}

const ADAPTER: &str = r#"export function records(text) {
  const out = { time: [], instrument: [], level: [], value: [] };
  for (const snap of JSON.parse(text).snapshots) {
    for (const [name, price] of Object.entries(snap.levels)) {
      out.time.push(snap.ts);
      out.instrument.push(snap.symbol);
      out.level.push(name);
      out.value.push(price);
    }
  }
  return out;
}
"#;

#[tokio::test]
async fn a_nested_file_is_read_by_a_javascript_adapter_and_saved() {
    let dir = tempfile::tempdir().unwrap();
    let data = dir.path().join("data");
    let config = RuntimeConfig {
        data_dir: Some(data.clone()),
        ..RuntimeConfig::default()
    };
    let rt = Runtime::build(
        config,
        vec![
            Fakes {
                tick: None,
                ..Fakes::default()
            }
            .module(),
        ],
    )
    .await
    .unwrap();
    let inv = Arc::clone(&rt.state().invoker);
    let agent = Origin::Agent {
        session_id: SessionId::new("L2"),
        provider: "codex".into(),
    };
    inv.set_policy(&agent, SessionPolicy::with_mode(SessionMode::AutoModify));
    std::fs::create_dir_all(&data).unwrap();
    let path = data.join("zeta.json");
    std::fs::write(
        &path,
        r#"{"vendor": "Zeta", "snapshots": [
            {"ts": "2026-10-07T09:31:00-04:00", "symbol": "SPX", "levels": {"hvl": 5800.5, "flip": null}},
            {"ts": "2026-10-07T09:36:00-04:00", "symbol": "SPX", "levels": {"hvl": 5810, "flip": 5790}}
        ]}"#,
    )
    .unwrap();
    let path = path.to_str().unwrap().to_owned();
    let p = call(&inv, &agent, "intel.preview_file", json!({"path": path})).await;
    assert_eq!(p["format"], "json_object");
    assert!(p["sample"]["snapshots"].is_array());
    let input = |dry: bool| {
        json!({
            "path": path,
            "adapter": {"kind": "script", "vendor": "Zeta Gamma", "code": ADAPTER},
            "dryRun": dry,
            "save": !dry
        })
    };
    let dry = call(&inv, &agent, "intel.import_level_history", input(true)).await;
    assert_eq!(dry["records"], 4);
    assert_eq!(dry["series"][0]["name"], "zeta-gamma.flip");
    let flip = dry["samples"]
        .as_array()
        .unwrap()
        .iter()
        .find(|r| r["name"] == "zeta-gamma.flip")
        .unwrap();
    assert_eq!(flip["value"], Value::Null, "null is not applicable");
    let done = call(&inv, &agent, "intel.import_level_history", input(false)).await;
    assert_eq!(done["imported"], 4);
    assert_eq!(done["saved"], "zeta-gamma");
    let again = call(
        &inv,
        &agent,
        "intel.import_level_history",
        json!({"path": path, "adapter": {"kind": "saved", "vendor": "Zeta Gamma"}}),
    )
    .await;
    assert_eq!(again["duplicates"], 4);
    assert_eq!(again["adapter"], "script:zeta-gamma");
}
