mod common;

use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use async_trait::async_trait;
use parking_lot::Mutex;
use serde_json::{Value, json};
use tessera_core::{Origin, SharedClock, Timestamp};
use tessera_intel::source::http::{HttpClient, HttpError, HttpRequest, HttpResponse};
use tessera_runtime::level_sources::RECORDS_KEY;
use tessera_runtime::secrets::Secrets;
use tessera_runtime::{Runtime, RuntimeConfig, RuntimeHandle};
use tessera_testkit::Fakes;
use tessera_testkit::ShiftedClock;
use tessera_tools::{Audience, InvokeRequest};

use common::Client;

const KEY: &str = "acme_custom_test-key-0123456789";
const GAMMA: &str = "acme-gamma";

#[derive(Default)]
struct Vendor {
    calls: Mutex<Vec<String>>,
    lapsed: AtomicBool,
}

#[async_trait]
impl HttpClient for Vendor {
    async fn get(&self, req: HttpRequest) -> Result<HttpResponse, HttpError> {
        self.calls.lock().push(req.url.clone());
        let auth = req
            .headers
            .iter()
            .find(|(k, _)| k == "Authorization")
            .map(|(_, v)| v.clone());
        let ok = |v: Value| {
            Ok(HttpResponse {
                status: 200,
                body: serde_json::to_vec(&v).unwrap(),
            })
        };
        if (req.url.contains("/gamma/") || req.url.contains("/conversion"))
            && (self.lapsed.load(Ordering::Relaxed)
                || auth.as_deref() != Some(&format!("Bearer {KEY}")))
        {
            return Ok(HttpResponse {
                status: 401,
                body: Vec::new(),
            });
        }
        let u = req.url.as_str();
        if u.ends_with("/gamma/NDX") {
            ok(
                json!({"timestamp": 1_791_486_350, "ticker": "NDX", "spot": 30683.32,
                "zero_gamma": 30776.18, "major_pos_vol": 30800, "major_pos_oi": 31000,
                "major_neg_vol": 30700, "major_neg_oi": 30750}),
            )
        } else if u.ends_with("/conversion") {
            ok(json!({"future_contract": "NQZ6", "multiplier": 1, "additive": 150}))
        } else if u.ends_with("/v1/levels/QQQ") {
            ok(json!({"asOf": "2026-10-08T15:00:00-04:00", "levels": [
                {"name": "hvl", "label": "High Vol Level", "price": 600.5},
                {"name": "pivot", "label": "Pivot", "price": 598}
            ]}))
        } else {
            Ok(HttpResponse {
                status: 404,
                body: b"{}".to_vec(),
            })
        }
    }
}

fn gamma_spec() -> Value {
    json!({
        "version": 1, "id": GAMMA, "name": "Acme gamma", "vendor": "Acme",
        "baseUrl": "https://api.acme.test/v1",
        "auth": {"in": "header", "name": "Authorization", "prefix": "Bearer "},
        "instruments": [{"root": "NQ", "ticker": "NDX", "convert": {"model": "request",
            "path": "/conversion", "query": {"ticker": "{ticker}", "future": "{root}"},
            "multiplier": "multiplier", "additive": "additive", "contract": "future_contract",
            "method": "additive"}}],
        "requests": [{"id": "classic", "package": "Classic", "path": "/gamma/{ticker}",
            "asOf": {"path": "timestamp"}, "spot": "spot", "group": "gamma",
            "fields": [
                {"field": "zero_gamma", "label": "Zero Gamma", "short": "ZG", "naIf": [0]},
                {"field": "major_pos_vol", "label": "Major Positive Volume", "naIf": [0]}
            ]}],
        "schedule": {"everySeconds": 120, "window": {"session": "us_rth"}}
    })
}

fn legacy_record(id: &str, name: &str) -> Value {
    json!([{
        "id": id, "kind": id, "displayName": name,
        "entitlements": {"tier": "quant", "addons": [], "rest": true},
        "credential": {"store": "keyring", "key": format!("levels.{id}")}
    }])
}

fn config(dir: &std::path::Path, secrets: &Secrets, vendor: &Arc<Vendor>) -> RuntimeConfig {
    let clock: SharedClock = Arc::new(ShiftedClock::starting_at(
        Timestamp::parse("2026-10-02T14:42:30-04:00").unwrap(),
    ));
    RuntimeConfig {
        clock,
        data_dir: Some(dir.to_path_buf()),
        secrets: Some(secrets.clone()),
        level_http: Some(Arc::clone(vendor) as Arc<dyn HttpClient>),
        ..RuntimeConfig::default()
    }
}

async fn start(config: RuntimeConfig) -> RuntimeHandle {
    Runtime::build(
        config,
        vec![
            Fakes {
                intraday_sessions: 1,
                tick: Some(Duration::from_millis(50)),
                gamma: false,
                ..Fakes::default()
            }
            .module(),
        ],
    )
    .await
    .unwrap()
    .spawn()
}

async fn invoke(c: &mut Client, name: &str, input: Value) -> Value {
    c.ok("tools.invoke", json!({"name": name, "input": input}))
        .await
}

async fn sources(c: &mut Client) -> Vec<Value> {
    invoke(c, "intel.list_sources", json!({})).await["output"]["sources"]
        .as_array()
        .unwrap()
        .clone()
}

async fn listed_sources(c: &mut Client) -> Vec<Value> {
    c.settle(
        "the level sources are listed",
        |c| Box::pin(sources(c)),
        |list| !list.is_empty(),
    )
    .await
}

fn health_of(h: &RuntimeHandle, id: &str) -> Vec<(Value, Value, Value)> {
    serde_json::to_value(h.state.health()).unwrap()["providers"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|p| p["providerId"] == id)
        .map(|p| (p["kind"].clone(), p["status"].clone(), p["message"].clone()))
        .collect()
}

fn down_as_levels(message: &str) -> Vec<(Value, Value, Value)> {
    vec![(json!("intelligence"), json!("down"), json!(message))]
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_source_with_a_secret_is_tried_added_served_restored_and_removed() {
    let dir = tempfile::tempdir().unwrap();
    let secrets = Secrets::in_memory();
    let vendor = Arc::new(Vendor::default());
    let h = start(config(dir.path(), &secrets, &vendor)).await;
    let mut c = Client::new(&h).await;

    let registry = h.state.invoker.registry();
    for name in [
        "connections.add_level_source",
        "connections.test_level_source",
    ] {
        assert!(
            registry
                .descriptors(Audience::Agent, None, true)
                .iter()
                .all(|d| d.name != name),
            "{name} is visible to agents"
        );
        let r = h
            .state
            .invoker
            .invoke(InvokeRequest::new(
                name,
                json!({"spec": gamma_spec(), "secret": KEY}),
                Origin::External {
                    client_id: "mcp-client".into(),
                },
            ))
            .await;
        let r = serde_json::to_value(r).unwrap();
        assert_eq!(r["error"]["code"], "permission_denied", "{name}: {r}");
    }
    assert!(sources(&mut c).await.is_empty());

    let bad = invoke(
        &mut c,
        "connections.test_level_source",
        json!({"spec": gamma_spec(), "secret": "nope"}),
    )
    .await;
    assert_eq!(bad["output"]["ok"], false, "{bad}");
    assert!(bad.to_string().contains("refused the key"), "{bad}");
    let good = invoke(
        &mut c,
        "connections.test_level_source",
        json!({"spec": gamma_spec(), "secret": KEY, "instrument": "NQ"}),
    )
    .await;
    assert_eq!(good["output"]["ok"], true, "{good}");

    let added = invoke(
        &mut c,
        "connections.add_level_source",
        json!({"spec": gamma_spec(), "secret": format!(" {KEY} ")}),
    )
    .await;
    assert_eq!(added["ok"], true, "{added}");
    assert_eq!(added["output"]["connection"]["id"], GAMMA);
    assert_eq!(added["output"]["connection"]["intel"]["vendor"], "Acme");
    assert_eq!(added["output"]["storedIn"], "keyring");

    let stored = h.state.store.settings().get(RECORDS_KEY).unwrap().unwrap();
    assert!(!stored.to_string().contains(KEY), "{stored}");
    assert_eq!(stored[0]["kind"], "spec");

    let list = sources(&mut c).await;
    assert_eq!(list.len(), 1, "{list:?}");
    let keys: Vec<&str> = list[0]["packages"]
        .as_array()
        .unwrap()
        .iter()
        .map(|p| p["key"].as_str().unwrap())
        .collect();
    assert_eq!(keys, ["acme-gamma.classic"]);
    assert_eq!(list[0]["editable"], true);
    assert_eq!(list[0]["sendsSecret"], true);
    assert_eq!(list[0]["history"], Value::Null);
    assert_eq!(list[0]["schedule"], "Every 2 min, US market hours");
    let r = invoke(&mut c, "intel.get_levels", json!({"instrument": "NQ"})).await;
    assert_eq!(r["ok"], true, "{r}");
    assert_eq!(r["output"]["provider"], GAMMA);
    let levels = r["output"]["levels"].as_array().unwrap();
    let zg = levels
        .iter()
        .find(|l| l["key"] == "acme-gamma.classic.zero_gamma")
        .unwrap();
    assert_eq!(zg["label"], "Zero Gamma");
    assert_eq!(zg["source"]["field"], "zero_gamma");
    assert_eq!(zg["source"]["endpoint"], "classic");
    assert_eq!(zg["nativePrice"], json!(30776.18));
    assert_eq!(zg["price"], json!(30926.25));
    assert_eq!(zg["source"]["conversion"]["additive"], json!(150));
    let conv = invoke(
        &mut c,
        "intel.get_conversion",
        json!({"from": "NDX", "to": "NQ", "provider": GAMMA}),
    )
    .await;
    assert_eq!(conv["output"]["contract"], "NQZ6", "{conv}");
    drop(c);
    h.shutdown().await.unwrap();

    let h = start(config(dir.path(), &secrets, &vendor)).await;
    let mut c = Client::new(&h).await;
    let back = listed_sources(&mut c).await;
    assert_eq!(back[0]["providerId"], GAMMA, "{back:?}");

    let removed = invoke(&mut c, "connections.remove", json!({"id": GAMMA})).await;
    assert_eq!(removed["output"]["removed"], true, "{removed}");
    assert!(sources(&mut c).await.is_empty());
    let stored = h.state.store.settings().get(RECORDS_KEY).unwrap().unwrap();
    assert_eq!(stored, json!([]));
    h.shutdown().await.unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_source_from_a_spec_is_tried_added_and_served() {
    let dir = tempfile::tempdir().unwrap();
    let secrets = Secrets::in_memory();
    let vendor = Arc::new(Vendor::default());
    let h = start(config(dir.path(), &secrets, &vendor)).await;
    let mut c = Client::new(&h).await;
    let spec = json!({
        "version": 1, "id": "acme", "name": "Acme levels", "vendor": "Acme",
        "baseUrl": "https://api.acme.test/v1",
        "instruments": [{"root": "QQQ", "ticker": "QQQ"}],
        "requests": [{"id": "main", "package": "Main", "path": "/levels/{ticker}",
            "asOf": {"path": "asOf", "unit": "rfc3339"},
            "items": {"path": "levels", "field": "name", "price": "price", "label": "label"}}],
        "schedule": {"everySeconds": 300}
    });
    let tried = invoke(
        &mut c,
        "intel.test_source",
        json!({"spec": spec, "samples": {"main": {"asOf": "2026-10-08T15:00:00-04:00",
            "levels": [{"name": "hvl", "label": "High Vol Level", "price": 600.5}]}}}),
    )
    .await;
    assert_eq!(tried["output"]["ok"], true, "{tried}");
    assert_eq!(
        tried["output"]["requests"][0]["levels"][0]["key"],
        "acme.main.hvl"
    );
    assert_eq!(vendor.calls.lock().len(), 0);

    let added = invoke(
        &mut c,
        "connections.add_level_source",
        json!({"spec": spec}),
    )
    .await;
    assert_eq!(added["ok"], true, "{added}");
    assert_eq!(added["output"]["storedIn"], Value::Null);
    let r = invoke(
        &mut c,
        "intel.get_levels",
        json!({"instrument": "QQQ", "provider": "acme"}),
    )
    .await;
    assert_eq!(r["ok"], true, "{r}");
    let levels = r["output"]["levels"].as_array().unwrap();
    assert_eq!(levels[0]["label"], "High Vol Level");
    assert_eq!(levels[0]["source"]["vendor"], "Acme");
    assert_eq!(levels[0]["price"], json!(600.5));
    let list = sources(&mut c).await;
    assert_eq!(list.len(), 1, "{list:?}");
    assert_eq!(list[0]["spec"]["id"], "acme");
    assert_eq!(list[0]["editable"], true);
    let removed = invoke(&mut c, "connections.remove", json!({"id": "acme"})).await;
    assert_eq!(removed["output"]["removed"], true);
    h.shutdown().await.unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn saved_keys_are_listed_and_tested_without_their_values() {
    const ACME_SECRET: &str = "acme-secret-0123456789";
    let dir = tempfile::tempdir().unwrap();
    let secrets = Secrets::in_memory();
    let vendor = Arc::new(Vendor::default());
    let h = start(config(dir.path(), &secrets, &vendor)).await;
    let mut c = Client::new(&h).await;

    let r = h
        .state
        .invoker
        .invoke(InvokeRequest::new(
            "connections.list_credentials",
            json!({}),
            Origin::External {
                client_id: "mcp-client".into(),
            },
        ))
        .await;
    let r = serde_json::to_value(r).unwrap();
    assert_eq!(r["error"]["code"], "permission_denied", "{r}");

    let spec = |id: &str, name: &str, auth: bool| {
        let mut s = json!({
            "version": 1, "id": id, "name": name, "vendor": "Acme",
            "baseUrl": "https://api.acme.test/v1",
            "instruments": [{"root": "QQQ", "ticker": "QQQ"}],
            "requests": [{"id": "main", "package": "Main", "path": "/levels/{ticker}",
                "asOf": {"path": "asOf", "unit": "rfc3339"},
                "items": {"path": "levels", "field": "name", "price": "price", "label": "label"}}],
            "schedule": {"everySeconds": 300}
        });
        if auth {
            s["auth"] = json!({"in": "header", "name": "X-Api-Key"});
        }
        s
    };
    let added = invoke(
        &mut c,
        "connections.add_level_source",
        json!({"spec": spec("acme", "Acme levels", true), "secret": ACME_SECRET}),
    )
    .await;
    assert_eq!(added["ok"], true, "{added}");
    let added = invoke(
        &mut c,
        "connections.add_level_source",
        json!({"spec": spec("open", "Open levels", false)}),
    )
    .await;
    assert_eq!(added["ok"], true, "{added}");
    let edited = invoke(
        &mut c,
        "connections.add_level_source",
        json!({"spec": spec("acme", "Acme levels", true)}),
    )
    .await;
    assert_eq!(
        edited["ok"], true,
        "editing keeps the saved secret: {edited}"
    );

    let out = invoke(&mut c, "connections.list_credentials", json!({})).await;
    assert_eq!(
        out["output"]["credentials"],
        json!([
            {"connectionId": "acme", "kind": "level_source", "name": "Acme levels", "system": null,
             "user": null, "gateway": null, "store": "keyring",
             "location": "OS keyring, service tessera, key levels.acme",
             "state": "stored", "message": null},
        ]),
        "{out}"
    );
    let text = out.to_string();
    assert!(!text.contains(ACME_SECRET), "{text}");

    let t = invoke(&mut c, "connections.test_credential", json!({"id": "acme"})).await;
    assert_eq!(t["output"]["ok"], true, "{t}");
    assert_eq!(
        t["output"]["message"],
        "Acme levels answered with its saved secret: 2 levels."
    );

    secrets
        .delete_everywhere(&tessera_core::accounts::CredentialRef {
            store: tessera_core::accounts::CredentialStore::Keyring,
            key: "levels.acme".into(),
        })
        .await
        .unwrap();
    let out = invoke(&mut c, "connections.list_credentials", json!({})).await;
    let acme = &out["output"]["credentials"][0];
    assert_eq!(acme["state"], "missing", "{out}");
    assert!(
        acme["message"]
            .as_str()
            .unwrap()
            .contains("missing from the OS keyring"),
        "{out}"
    );
    let t = invoke(&mut c, "connections.test_credential", json!({"id": "acme"})).await;
    assert_eq!(t["output"]["ok"], false, "{t}");
    let r = invoke(&mut c, "connections.test_credential", json!({"id": "nope"})).await;
    assert_eq!(r["error"]["code"], "not_found", "{r}");
    drop(c);
    h.shutdown().await.unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_drafted_source_waits_for_the_user_and_goes_once_saved() {
    let dir = tempfile::tempdir().unwrap();
    let secrets = Secrets::in_memory();
    let vendor = Arc::new(Vendor::default());
    let h = start(config(dir.path(), &secrets, &vendor)).await;
    let mut c = Client::new(&h).await;
    let spec = json!({
        "version": 1, "id": "acme", "name": "Acme levels", "vendor": "Acme",
        "baseUrl": "https://api.acme.test/v1",
        "instruments": [{"root": "QQQ", "ticker": "QQQ"}],
        "requests": [{"id": "main", "package": "Main", "path": "/levels/{ticker}",
            "items": {"path": "levels", "field": "name", "price": "price", "label": "label"}}],
        "schedule": {"everySeconds": 300}
    });
    let agent_tools: Vec<String> = h
        .state
        .invoker
        .registry()
        .descriptors(Audience::Agent, None, true)
        .iter()
        .map(|d| d.name.clone())
        .collect();
    for t in [
        "intel.draft_source",
        "intel.list_source_drafts",
        "intel.discard_source_draft",
    ] {
        assert!(agent_tools.iter().any(|n| n == t), "{t}");
    }
    let drafted = invoke(
        &mut c,
        "intel.draft_source",
        json!({"spec": spec, "samples": {"main": {"levels": []}}, "note": "Check the ticker."}),
    )
    .await;
    assert_eq!(drafted["ok"], true, "{drafted}");
    assert_eq!(drafted["output"]["problems"], json!([]));
    let list = invoke(&mut c, "intel.list_source_drafts", json!({})).await;
    assert_eq!(list["output"]["drafts"][0]["id"], "acme", "{list}");
    assert_eq!(list["output"]["drafts"][0]["note"], "Check the ticker.");

    let added = invoke(
        &mut c,
        "connections.add_level_source",
        json!({"spec": spec}),
    )
    .await;
    assert_eq!(added["ok"], true, "{added}");
    let list = invoke(&mut c, "intel.list_source_drafts", json!({})).await;
    assert_eq!(list["output"]["drafts"], json!([]), "{list}");

    let mut other = spec.clone();
    other["id"] = json!("other");
    invoke(&mut c, "intel.draft_source", json!({"spec": other})).await;
    let gone = invoke(&mut c, "intel.discard_source_draft", json!({"id": "other"})).await;
    assert_eq!(gone["output"]["discarded"], true, "{gone}");
    h.shutdown().await.unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_source_an_earlier_tessera_had_built_in_waits_to_be_added_again_with_its_key() {
    let dir = tempfile::tempdir().unwrap();
    let secrets = Secrets::in_memory();
    let vendor = Arc::new(Vendor::default());
    secrets.put(&format!("levels.{GAMMA}"), KEY).await.unwrap();
    let h = start(config(dir.path(), &secrets, &vendor)).await;
    h.state
        .store
        .settings()
        .set(
            RECORDS_KEY,
            &legacy_record(GAMMA, "Acme"),
            Timestamp::parse("2026-10-02T14:42:30-04:00").unwrap(),
        )
        .unwrap();
    h.shutdown().await.unwrap();

    let h = start(config(dir.path(), &secrets, &vendor)).await;
    let mut c = Client::new(&h).await;
    let list = listed_sources(&mut c).await;
    assert_eq!(list.len(), 1, "{list:?}");
    assert_eq!(list[0]["providerId"], GAMMA);
    assert_eq!(list[0]["editable"], false);
    assert_eq!(list[0]["sendsSecret"], true);
    assert_eq!(list[0]["packages"], json!([]));
    assert_eq!(list[0]["health"]["status"], "down");
    let words = list[0]["health"]["message"].as_str().unwrap().to_owned();
    assert!(words.contains("built into an earlier Tessera"), "{words}");
    assert!(words.contains("Any API, with the analyst"), "{words}");
    assert_eq!(health_of(&h, GAMMA), down_as_levels(&words));
    let asked = invoke(&mut c, "intel.get_levels", json!({"instrument": "NQ"})).await;
    assert_ne!(asked["ok"], true, "{asked}");
    let t = invoke(&mut c, "connections.test_credential", json!({"id": GAMMA})).await;
    assert_eq!(t["output"], json!({"ok": false, "message": words}), "{t}");
    assert!(!vendor.calls.lock().iter().any(|u| u.contains("/gamma/")));

    let added = invoke(
        &mut c,
        "connections.add_level_source",
        json!({"spec": gamma_spec()}),
    )
    .await;
    assert_eq!(added["ok"], true, "the saved key is kept: {added}");
    let list = sources(&mut c).await;
    assert_eq!(list.len(), 1, "{list:?}");
    assert_eq!(list[0]["editable"], true);
    let r = invoke(&mut c, "intel.get_levels", json!({"instrument": "NQ"})).await;
    assert_eq!(r["ok"], true, "{r}");
    assert_eq!(r["output"]["provider"], GAMMA);
    let stored = h.state.store.settings().get(RECORDS_KEY).unwrap().unwrap();
    assert_eq!(stored[0]["kind"], "spec");
    assert_eq!(stored[0]["credential"]["key"], format!("levels.{GAMMA}"));
    drop(c);
    h.shutdown().await.unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_retired_record_without_a_key_is_removed_cleanly() {
    let dir = tempfile::tempdir().unwrap();
    let secrets = Secrets::in_memory();
    let vendor = Arc::new(Vendor::default());
    let h = start(config(dir.path(), &secrets, &vendor)).await;
    let mut record = legacy_record("old", "Old vendor");
    record[0]["credential"] = Value::Null;
    h.state
        .store
        .settings()
        .set(
            RECORDS_KEY,
            &record,
            Timestamp::parse("2026-10-02T14:42:30-04:00").unwrap(),
        )
        .unwrap();
    h.shutdown().await.unwrap();

    let h = start(config(dir.path(), &secrets, &vendor)).await;
    let mut c = Client::new(&h).await;
    let list = listed_sources(&mut c).await;
    assert_eq!(list[0]["sendsSecret"], false, "{list:?}");
    let removed = invoke(&mut c, "connections.remove", json!({"id": "old"})).await;
    assert_eq!(removed["output"]["removed"], true, "{removed}");
    assert!(sources(&mut c).await.is_empty());
    drop(c);
    h.shutdown().await.unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_saved_key_refused_after_a_restart_shows_once_a_chart_asks() {
    let dir = tempfile::tempdir().unwrap();
    let secrets = Secrets::in_memory();
    let vendor = Arc::new(Vendor::default());
    let h = start(config(dir.path(), &secrets, &vendor)).await;
    let mut c = Client::new(&h).await;
    let added = invoke(
        &mut c,
        "connections.add_level_source",
        json!({"spec": gamma_spec(), "secret": KEY}),
    )
    .await;
    assert_eq!(added["ok"], true, "{added}");
    drop(c);
    h.shutdown().await.unwrap();

    vendor.lapsed.store(true, Ordering::Relaxed);
    let h = start(config(dir.path(), &secrets, &vendor)).await;
    let mut c = Client::new(&h).await;
    assert_eq!(listed_sources(&mut c).await[0]["providerId"], GAMMA);
    let asked = invoke(&mut c, "intel.get_levels", json!({"instrument": "NQ"})).await;
    assert_ne!(asked["ok"], true, "{asked}");

    let refusal = "Acme refused the key (401). Change it in Settings › Connections.";
    let list = sources(&mut c).await;
    assert_eq!(list[0]["health"]["status"], "down", "{list:?}");
    assert_eq!(list[0]["health"]["message"], refusal);
    assert_eq!(health_of(&h, GAMMA), down_as_levels(refusal));
    drop(c);
    h.shutdown().await.unwrap();
}
