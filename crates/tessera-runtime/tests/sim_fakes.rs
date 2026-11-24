mod common;

use serde_json::{Value, json};
use tessera_runtime::secrets::Secrets;
use tessera_runtime::{Runtime, RuntimeConfig, RuntimeHandle};
use tessera_testkit::levels::{self, GOOD_KEY, SOURCE_ID};
use tessera_testkit::rithmic::{
    self, CONNECTION_ID, GATEWAYS, GOOD_PASSWORD, LATENCY_MS, REFUSAL, SYSTEM, account_name,
};
use tessera_testkit::{Fakes, frozen_clock};

use common::Client;

const REFUSED_LOGIN: &str = "Rithmic refused the login: permission denied (code 13)";

async fn sim() -> RuntimeHandle {
    let clock = frozen_clock();
    let config = RuntimeConfig {
        clock: clock.clone(),
        secrets: Some(Secrets::in_memory()),
        rithmic: rithmic::factory(clock),
        level_http: levels::vendors(),
        ..RuntimeConfig::default()
    };
    Runtime::build(config, vec![Fakes::still(20).module()])
        .await
        .unwrap()
        .spawn()
}

async fn invoke(c: &mut Client, name: &str, input: Value) -> Value {
    c.ok("tools.invoke", json!({"name": name, "input": input}))
        .await
}

async fn output(c: &mut Client, name: &str, input: Value) -> Value {
    let r = invoke(c, name, input).await;
    assert_eq!(r["ok"], true, "{name}: {r}");
    r["output"].clone()
}

async fn refusal(c: &mut Client, name: &str, input: Value) -> Value {
    let r = invoke(c, name, input).await;
    assert_eq!(r["ok"], false, "{name} should be refused: {r}");
    r["error"].clone()
}

fn login(user: &str, gateway: &str, password: &str) -> Value {
    json!({"system": SYSTEM, "gateway": gateway, "user": user, "password": password})
}

async fn connections(c: &mut Client) -> Value {
    output(c, "connections.list", json!({})).await
}

fn connection(list: &Value, id: &str) -> Option<Value> {
    list["connections"]
        .as_array()
        .unwrap()
        .iter()
        .find(|x| x["id"] == id)
        .cloned()
}

async fn nq_candles(c: &mut Client) -> Value {
    let out = output(
        c,
        "market.get_candles",
        json!({"instrument": "NQ", "tf": "1m", "limit": 50}),
    )
    .await;
    assert!(!out["bars"].as_array().unwrap().is_empty(), "{out}");
    out
}

async fn account_names(c: &mut Client) -> Vec<String> {
    output(c, "portfolio.get_accounts", json!({})).await["accounts"]
        .as_array()
        .unwrap()
        .iter()
        .map(|u| u["account"]["displayName"].as_str().unwrap().to_owned())
        .collect()
}

async fn credential(c: &mut Client, id: &str) -> Option<Value> {
    output(c, "connections.list_credentials", json!({})).await["credentials"]
        .as_array()
        .unwrap()
        .iter()
        .find(|x| x["connectionId"] == id)
        .cloned()
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_fake_rithmic_login_is_added_tested_edited_switched_and_removed() {
    let h = sim().await;
    let mut c = Client::new(&h).await;

    let systems = output(&mut c, "connections.rithmic_directory", json!({})).await;
    assert_eq!(systems["systems"], json!([SYSTEM]), "{systems}");
    let gateways = output(
        &mut c,
        "connections.rithmic_directory",
        json!({"system": SYSTEM}),
    )
    .await;
    let names: Vec<&str> = GATEWAYS.iter().map(|(name, _)| *name).collect();
    assert_eq!(gateways["gateways"], json!(names), "{gateways}");
    assert_eq!(gateways["problem"], Value::Null);

    let before = nq_candles(&mut c).await;
    let list = connections(&mut c).await;
    assert_eq!(list["dataSource"], "mock");
    assert!(connection(&list, CONNECTION_ID).is_none());

    let refused = login("alice", "Chicago Area", "not-demo");
    let tested = output(&mut c, "connections.test_rithmic", refused.clone()).await;
    assert_eq!(tested["ok"], false);
    assert!(
        tested["message"].as_str().unwrap().contains(REFUSED_LOGIN),
        "{tested}"
    );
    let error = refusal(&mut c, "connections.add_rithmic", refused).await;
    assert_eq!(error["code"], "rejected", "{error}");
    assert!(error["message"].as_str().unwrap().contains(REFUSAL));
    assert!(connection(&connections(&mut c).await, CONNECTION_ID).is_none());
    assert!(credential(&mut c, CONNECTION_ID).await.is_none());

    let good = login("alice", "Chicago Area", GOOD_PASSWORD);
    let tested = output(&mut c, "connections.test_rithmic", good.clone()).await;
    assert_eq!(
        tested,
        json!({"ok": true, "message": format!("Logged in to {SYSTEM}.")})
    );

    let added = output(&mut c, "connections.add_rithmic", good).await;
    let added = &added["connection"];
    assert_eq!(added["id"], CONNECTION_ID);
    assert_eq!(added["enabled"], true);
    assert_eq!(added["health"]["status"], "ok");
    assert_eq!(added["health"]["latencyMs"], json!(LATENCY_MS));
    assert_eq!(added["broker"]["readOnly"], true);
    let list = connections(&mut c).await;
    let listed = connection(&list, CONNECTION_ID).expect("the login is listed");
    assert_eq!(listed["health"]["status"], "ok");
    assert_eq!(listed["health"]["latencyMs"], json!(LATENCY_MS));
    assert_eq!(listed["displayName"], "Tessera Test · Rithmic");
    assert_eq!(list["dataSource"], "mock", "adding a login moves no chart");
    assert!(account_names(&mut c).await.contains(&account_name("alice")));
    assert_eq!(nq_candles(&mut c).await, before);

    let kept = credential(&mut c, CONNECTION_ID)
        .await
        .expect("a saved login");
    assert_eq!(kept["kind"], "rithmic");
    assert_eq!(kept["system"], SYSTEM);
    assert_eq!(kept["user"], "alice");
    assert_eq!(kept["gateway"], "Chicago Area");
    assert_eq!(kept["state"], "stored");
    assert!(!kept.to_string().contains(GOOD_PASSWORD));
    let tested = output(
        &mut c,
        "connections.test_credential",
        json!({"id": CONNECTION_ID}),
    )
    .await;
    assert_eq!(tested["ok"], true, "{tested}");

    let wrong = refusal(
        &mut c,
        "connections.replace_rithmic",
        login("bob", "Europe", "not-demo"),
    )
    .await;
    assert_eq!(wrong["code"], "rejected", "{wrong}");
    assert!(
        wrong["message"]
            .as_str()
            .unwrap()
            .contains("Nothing changed")
    );
    assert_eq!(
        credential(&mut c, CONNECTION_ID).await.unwrap()["user"],
        "alice"
    );
    let replaced = output(
        &mut c,
        "connections.replace_rithmic",
        login("bob", "Europe", GOOD_PASSWORD),
    )
    .await;
    assert_eq!(replaced["connection"]["health"]["status"], "ok");
    let kept = credential(&mut c, CONNECTION_ID).await.unwrap();
    assert_eq!(
        (&kept["user"], &kept["gateway"]),
        (&json!("bob"), &json!("Europe"))
    );
    let accounts = account_names(&mut c).await;
    assert!(accounts.contains(&account_name("bob")), "{accounts:?}");
    assert!(!accounts.contains(&account_name("alice")), "{accounts:?}");

    let off = output(
        &mut c,
        "connections.set_enabled",
        json!({"id": CONNECTION_ID, "enabled": false}),
    )
    .await;
    assert_eq!(off["connection"]["enabled"], false);
    assert_eq!(off["connection"]["health"]["status"], "disconnected");
    assert_eq!(off["connection"]["health"]["message"], "Off.");
    assert!(!account_names(&mut c).await.contains(&account_name("bob")));
    assert_eq!(nq_candles(&mut c).await, before);
    let tested = output(
        &mut c,
        "connections.test_credential",
        json!({"id": CONNECTION_ID}),
    )
    .await;
    assert_eq!(tested["ok"], true, "{tested}");

    let on = output(
        &mut c,
        "connections.set_enabled",
        json!({"id": CONNECTION_ID, "enabled": true}),
    )
    .await;
    assert_eq!(on["connection"]["enabled"], true);
    let status = c
        .settle(
            "the enabled connection is healthy",
            |c| {
                Box::pin(async move {
                    let list = connections(c).await;
                    connection(&list, CONNECTION_ID).unwrap()["health"].clone()
                })
            },
            |status| status["status"] == "ok",
        )
        .await;
    assert_eq!(status["status"], "ok", "{status}");
    assert_eq!(status["latencyMs"], json!(LATENCY_MS));
    assert!(account_names(&mut c).await.contains(&account_name("bob")));

    let again = output(
        &mut c,
        "connections.reconnect",
        json!({"id": CONNECTION_ID}),
    )
    .await;
    assert_eq!(again["connection"]["health"]["status"], "ok");

    let removed = output(&mut c, "connections.remove", json!({"id": CONNECTION_ID})).await;
    assert_eq!(removed["removed"], true);
    assert!(connection(&connections(&mut c).await, CONNECTION_ID).is_none());
    assert!(credential(&mut c, CONNECTION_ID).await.is_none());
    assert!(!account_names(&mut c).await.contains(&account_name("bob")));
    assert_eq!(nq_candles(&mut c).await, before);
    drop(c);
    h.shutdown().await.unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_fake_vendors_spec_is_tried_added_kept_and_removed() {
    let h = sim().await;
    let mut c = Client::new(&h).await;
    let before = nq_candles(&mut c).await;

    let tested = output(
        &mut c,
        "connections.test_level_source",
        json!({"spec": levels::spec(), "secret": "not-demo"}),
    )
    .await;
    assert_eq!(tested["ok"], false, "{tested}");
    assert!(tested.to_string().contains("401"), "{tested}");

    let tested = output(
        &mut c,
        "connections.test_level_source",
        json!({"spec": levels::spec(), "secret": GOOD_KEY}),
    )
    .await;
    assert_eq!(tested["ok"], true, "{tested}");
    let added = output(
        &mut c,
        "connections.add_level_source",
        json!({"spec": levels::spec(), "secret": GOOD_KEY}),
    )
    .await;
    assert_eq!(added["connection"]["id"], SOURCE_ID);
    let list = connections(&mut c).await;
    assert_eq!(list["dataSource"], "mock");
    assert_eq!(nq_candles(&mut c).await, before);

    let got = output(
        &mut c,
        "intel.get_levels",
        json!({"instrument": "NQ", "provider": SOURCE_ID}),
    )
    .await;
    assert_eq!(got["provider"], SOURCE_ID, "{got}");
    let keys: Vec<&str> = got["levels"]
        .as_array()
        .unwrap()
        .iter()
        .filter_map(|l| l["key"].as_str())
        .collect();
    assert!(keys.contains(&"acme.gamma.zero_gamma"), "{got}");
    let health = connection(&connections(&mut c).await, SOURCE_ID).unwrap()["health"].clone();
    assert_eq!(health["status"], "ok", "{health}");

    let kept = credential(&mut c, SOURCE_ID).await.expect("a saved key");
    assert_eq!(kept["kind"], "level_source");
    assert_eq!(kept["state"], "stored");
    let tested = output(
        &mut c,
        "connections.test_credential",
        json!({"id": SOURCE_ID}),
    )
    .await;
    assert_eq!(tested["ok"], true, "{tested}");

    let edited = output(
        &mut c,
        "connections.add_level_source",
        json!({"spec": levels::spec()}),
    )
    .await;
    assert_eq!(edited["connection"]["id"], SOURCE_ID);
    let tested = output(
        &mut c,
        "connections.test_credential",
        json!({"id": SOURCE_ID}),
    )
    .await;
    assert_eq!(
        tested["ok"], true,
        "an edit without a key keeps the saved one: {tested}"
    );
    let list = connections(&mut c).await;
    let sources = list["connections"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|x| x["id"] == SOURCE_ID)
        .count();
    assert_eq!(sources, 1);

    let removed = output(&mut c, "connections.remove", json!({"id": SOURCE_ID})).await;
    assert_eq!(removed["removed"], true);
    assert!(connection(&connections(&mut c).await, SOURCE_ID).is_none());
    assert!(credential(&mut c, SOURCE_ID).await.is_none());
    assert_eq!(nq_candles(&mut c).await, before);
    drop(c);
    h.shutdown().await.unwrap();
}
