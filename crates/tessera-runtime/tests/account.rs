use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};

use axum::Router;
use axum::extract::State;
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use serde_json::{Value, json};
use tessera_core::accounts::CredentialStore;
use tessera_core::clock::ManualClock;
use tessera_core::settle::{settle, settle_async};
use tessera_core::time::NANOS_PER_SEC;
use tessera_core::{Origin, Timestamp};
use tessera_runtime::modules::account::SESSION_KEY;
use tessera_runtime::secrets::{MemoryStore, SecretStore, Secrets};
use tessera_runtime::{Runtime, RuntimeConfig, RuntimeHandle};
use tessera_tools::{InvokeRequest, Invoker};

mod common;

use common::keychain::{Answer, Keychain};
use common::{Client, http};

struct Cloud {
    n: Mutex<usize>,
    access: Mutex<String>,
    refresh: Mutex<String>,
    standing: Mutex<&'static str>,
    verifiers: Mutex<Vec<String>>,
    checkins: Mutex<Vec<Value>>,
    signed_out: AtomicUsize,
}

impl Cloud {
    fn new() -> Arc<Self> {
        Arc::new(Self {
            n: Mutex::new(0),
            access: Mutex::new(String::new()),
            refresh: Mutex::new(String::new()),
            standing: Mutex::new("pending"),
            verifiers: Mutex::new(Vec::new()),
            checkins: Mutex::new(Vec::new()),
            signed_out: AtomicUsize::new(0),
        })
    }

    fn account(&self) -> Value {
        json!({
            "user": {"id": "usr_1", "email": "trader@example.test", "name": "Trader"},
            "access": *self.standing.lock().unwrap(),
            "entitlements": if *self.standing.lock().unwrap() == "full" { json!(["early_access"]) } else { json!([]) },
        })
    }

    fn session(&self) -> Value {
        let mut n = self.n.lock().unwrap();
        *n += 1;
        *self.access.lock().unwrap() = format!("a{n}");
        *self.refresh.lock().unwrap() = format!("r{n}");
        json!({"access_token": format!("a{n}"), "refresh_token": format!("r{n}"), "account": self.account()})
    }

    fn authorized(&self, h: &HeaderMap) -> bool {
        let held = self.access.lock().unwrap().clone();
        !held.is_empty()
            && h.get("authorization").and_then(|v| v.to_str().ok())
                == Some(format!("Bearer {held}").as_str())
    }
}

fn unauthorized(code: &str) -> Response {
    (
        StatusCode::UNAUTHORIZED,
        json!({ "error": code }).to_string(),
    )
        .into_response()
}

async fn token(State(c): State<Arc<Cloud>>, body: String) -> Response {
    let v: Value = serde_json::from_str(&body).unwrap();
    c.verifiers
        .lock()
        .unwrap()
        .push(v["code_verifier"].as_str().unwrap_or_default().to_owned());
    match v["code"].as_str() {
        Some("good") => axum::Json(c.session()).into_response(),
        Some("breaks-cloud") => (
            StatusCode::INTERNAL_SERVER_ERROR,
            json!({ "error": "internal" }).to_string(),
        )
            .into_response(),
        _ => unauthorized("rejected"),
    }
}

async fn refresh(State(c): State<Arc<Cloud>>, body: String) -> Response {
    let v: Value = serde_json::from_str(&body).unwrap();
    if v["refresh_token"] != *c.refresh.lock().unwrap() {
        return unauthorized("rejected");
    }
    axum::Json(c.session()).into_response()
}

async fn me(State(c): State<Arc<Cloud>>, h: HeaderMap) -> Response {
    if !c.authorized(&h) {
        return unauthorized("unauthorized");
    }
    axum::Json(c.account()).into_response()
}

async fn checkins(State(c): State<Arc<Cloud>>, h: HeaderMap, body: String) -> Response {
    if !c.authorized(&h) {
        return unauthorized("unauthorized");
    }
    c.checkins
        .lock()
        .unwrap()
        .push(serde_json::from_str(&body).unwrap());
    StatusCode::NO_CONTENT.into_response()
}

async fn sign_out(State(c): State<Arc<Cloud>>, h: HeaderMap) -> Response {
    if !c.authorized(&h) {
        return unauthorized("unauthorized");
    }
    c.signed_out.fetch_add(1, Ordering::SeqCst);
    StatusCode::NO_CONTENT.into_response()
}

async fn serve(cloud: &Arc<Cloud>) -> String {
    let app = Router::new()
        .route("/v1/auth/token", post(token))
        .route("/v1/auth/refresh", post(refresh))
        .route("/v1/me", get(me))
        .route("/v1/checkins", post(checkins))
        .route("/v1/auth/sign-out", post(sign_out))
        .with_state(Arc::clone(cloud));
    let l = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = l.local_addr().unwrap().port();
    tokio::spawn(async move { axum::serve(l, app).await.unwrap() });
    format!("http://127.0.0.1:{port}")
}

fn keychain() -> (Arc<MemoryStore>, Secrets) {
    let keyring = Arc::new(MemoryStore::new(CredentialStore::Keyring));
    let secrets = Secrets::with_stores(
        Some(Arc::clone(&keyring) as Arc<dyn SecretStore>),
        Some(Arc::new(MemoryStore::new(CredentialStore::DevFile))),
    );
    (keyring, secrets)
}

fn kept(keyring: &MemoryStore) -> Option<Value> {
    keyring
        .get(SESSION_KEY)
        .unwrap()
        .map(|v| serde_json::from_str(&v).unwrap())
}

async fn start(
    cloud_url: Option<String>,
    secrets: Secrets,
    clock: Arc<ManualClock>,
) -> RuntimeHandle {
    Runtime::build(
        RuntimeConfig {
            cloud_url,
            secrets: Some(secrets),
            clock,
            ..RuntimeConfig::default()
        },
        Vec::new(),
    )
    .await
    .unwrap()
    .spawn()
}

fn clock() -> Arc<ManualClock> {
    Arc::new(ManualClock::new(Timestamp(1_800_000_000 * NANOS_PER_SEC)))
}

async fn user(inv: &Invoker, name: &str, input: Value) -> Result<Value, String> {
    let r = inv
        .invoke(InvokeRequest::new(name, input, Origin::User))
        .await;
    match (r.ok, r.output, r.error) {
        (true, Some(out), _) => Ok(out),
        (_, _, e) => Err(format!("{:?} {e:?}", r.status)),
    }
}

async fn settled(h: &RuntimeHandle) -> Value {
    settle_async(
        "the account settles",
        move || async move {
            user(&h.state.invoker, "account.status", json!({}))
                .await
                .unwrap()
        },
        |s| s["phase"] != "loading" && s["checking"] == false,
    )
    .await
}

async fn callback(h: &RuntimeHandle, query: &str) -> (u16, String) {
    http(
        h.port,
        &format!(
            "GET /auth/callback?{query} HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n"
        ),
    )
    .await
}

fn param(url: &str, name: &str) -> String {
    url.split_once('?')
        .unwrap()
        .1
        .split('&')
        .find_map(|kv| kv.strip_prefix(&format!("{name}=")))
        .unwrap()
        .to_owned()
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn without_an_address_there_are_no_accounts() {
    let (_keyring, secrets) = keychain();
    let h = start(None, secrets, clock()).await;
    let s = user(&h.state.invoker, "account.status", json!({}))
        .await
        .unwrap();
    assert_eq!(s["phase"], "off");
    let e = user(&h.state.invoker, "account.sign_in", json!({}))
        .await
        .unwrap_err();
    assert!(e.contains("Unavailable"), "{e}");
    assert_eq!(callback(&h, "state=x&code=y").await.0, 404);
    h.shutdown().await.unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_sign_in_comes_back_once_with_its_own_state_and_is_kept() {
    let cloud = Cloud::new();
    let base = serve(&cloud).await;
    let (keyring, secrets) = keychain();
    let clock = clock();
    let h = start(Some(base.clone()), secrets, Arc::clone(&clock)).await;
    let inv = Arc::clone(&h.state.invoker);
    assert_eq!(settled(&h).await["phase"], "signed_out");

    let shown = user(&inv, "ui.show_area", json!({"area": "profile"}))
        .await
        .unwrap();
    assert_eq!(shown["area"], "profile");
    assert!(
        user(
            &inv,
            "ui.show_area",
            json!({"area": "profile", "item": "x"})
        )
        .await
        .is_err()
    );

    let url = user(&inv, "account.sign_in", json!({})).await.unwrap()["url"]
        .as_str()
        .unwrap()
        .to_owned();
    assert!(
        url.starts_with(&format!("{base}/auth/desktop/start?")),
        "{url}"
    );
    assert_eq!(
        param(&url, "redirect_uri"),
        format!("http%3A%2F%2F127.0.0.1%3A{}%2Fauth%2Fcallback", h.port)
    );
    let state = param(&url, "state");
    let challenge = param(&url, "code_challenge");
    assert_eq!(challenge.len(), 43);
    assert_eq!(settled(&h).await["signingIn"], true);

    let (status, page) = callback(&h, "state=someone-else&code=good").await;
    assert_eq!(status, 400, "{page}");
    assert!(page.contains("This sign-in link has expired"), "{page}");
    assert_eq!(callback(&h, "code=good").await.0, 400);
    assert!(
        cloud.verifiers.lock().unwrap().is_empty(),
        "nothing exchanged"
    );
    assert_eq!(settled(&h).await["signingIn"], true, "still waiting");

    let (status, page) = callback(&h, &format!("state={state}&code=good")).await;
    assert_eq!(status, 200, "{page}");
    assert!(page.contains("<h1>You’re signed in</h1>"), "{page}");
    assert!(page.contains("text/html"), "{page}");
    let verifier = cloud.verifiers.lock().unwrap()[0].clone();
    assert_eq!(tessera_cloud::pkce::challenge_of(&verifier), challenge);
    let s = settled(&h).await;
    assert_eq!(s["phase"], "signed_in");
    assert_eq!(s["user"]["email"], "trader@example.test");
    assert_eq!(s["access"], "pending");
    assert_eq!(s["signingIn"], false);
    let k = kept(&keyring).unwrap();
    assert_eq!(k["refresh_token"], "r1");
    assert_eq!(k["access"], "pending");

    let (status, _) = callback(&h, &format!("state={state}&code=good")).await;
    assert_eq!(status, 400);
    assert_eq!(cloud.verifiers.lock().unwrap().len(), 1);

    let url = user(&inv, "account.sign_in", json!({})).await.unwrap()["url"]
        .as_str()
        .unwrap()
        .to_owned();
    clock.advance(11 * 60 * NANOS_PER_SEC);
    let (status, _) = callback(&h, &format!("state={}&code=good", param(&url, "state"))).await;
    assert_eq!(status, 400);
    assert_eq!(cloud.verifiers.lock().unwrap().len(), 1, "never exchanged");
    assert_eq!(settled(&h).await["signingIn"], false);

    let url = user(&inv, "account.sign_in", json!({})).await.unwrap()["url"]
        .as_str()
        .unwrap()
        .to_owned();
    let (status, page) = callback(
        &h,
        &format!("state={}&error=access_denied", param(&url, "state")),
    )
    .await;
    assert_eq!(status, 400);
    assert!(page.contains("Sign-in was cancelled"), "{page}");
    let s = settled(&h).await;
    assert_eq!(s["signingIn"], false);
    assert!(s["problem"].as_str().is_some());
    assert_eq!(s["phase"], "signed_in", "the session it had stays");
    h.shutdown().await.unwrap();
}

struct Page {
    status: u16,
    headers: Vec<(String, String)>,
    body: String,
}

impl Page {
    fn of((status, raw): (u16, String)) -> Self {
        let (head, body) = raw.split_once("\r\n\r\n").unwrap();
        let headers = head
            .lines()
            .skip(1)
            .filter_map(|l| l.split_once(':'))
            .map(|(k, v)| (k.trim().to_ascii_lowercase(), v.trim().to_owned()))
            .collect();
        Self {
            status,
            headers,
            body: body.to_owned(),
        }
    }

    fn header(&self, name: &str) -> Vec<&str> {
        self.headers
            .iter()
            .filter(|(k, _)| k == name)
            .map(|(_, v)| v.as_str())
            .collect()
    }

    #[track_caller]
    fn says(&self, status: u16, headline: &str) {
        assert_eq!(self.status, status, "{headline}");
        assert!(
            self.body.contains(&format!("<h1>{headline}</h1>")),
            "{headline}: {}",
            &self.body[self.body.len().saturating_sub(600)..]
        );
        assert_eq!(
            self.header("content-type"),
            ["text/html; charset=utf-8"],
            "{headline}"
        );
        assert_eq!(self.header("cache-control"), ["no-store"], "{headline}");
        let policy = self.header("content-security-policy");
        assert_eq!(policy.len(), 1, "one policy, the page's own: {policy:?}");
        let policy = policy[0];
        for directive in [
            "default-src 'none'",
            "style-src 'sha256-",
            "font-src data:",
            "img-src data:",
            "base-uri 'none'",
            "form-action 'none'",
            "frame-ancestors 'none'",
        ] {
            assert!(policy.contains(directive), "{directive} in {policy}");
        }
        assert!(
            !policy.contains("script-src") && !policy.contains("unsafe"),
            "{policy}"
        );
        assert!(!self.body.contains("<script"), "{headline}");
        assert!(
            self.body.contains("background:#073f4f"),
            "the petrol ground"
        );
    }
}

async fn sign_in_state(inv: &Invoker) -> String {
    let url = user(inv, "account.sign_in", json!({})).await.unwrap()["url"]
        .as_str()
        .unwrap()
        .to_owned();
    param(&url, "state")
}

async fn back(h: &RuntimeHandle, query: &str) -> Page {
    Page::of(callback(h, query).await)
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn every_way_back_says_what_happened_on_a_branded_page() {
    let cloud = Cloud::new();
    let base = serve(&cloud).await;
    let (_keyring, secrets) = keychain();
    let h = start(Some(base), secrets, clock()).await;
    let inv = Arc::clone(&h.state.invoker);
    settled(&h).await;

    let p = back(&h, "state=%3Cscript%3Ealert(1)%3C%2Fscript%3E&code=good").await;
    p.says(400, "This sign-in link has expired");
    assert!(!p.body.contains("alert(1)"));

    let s = sign_in_state(&inv).await;
    back(&h, &format!("state={s}&error=access_denied"))
        .await
        .says(400, "Sign-in was cancelled");
    assert_eq!(
        settled(&h).await["problem"],
        "Sign-in was cancelled in the browser."
    );
    let s = sign_in_state(&inv).await;
    back(&h, &format!("state={s}&error=server_error"))
        .await
        .says(400, "Sign-in didn’t finish");
    let s = sign_in_state(&inv).await;
    back(&h, &format!("state={s}"))
        .await
        .says(400, "Sign-in didn’t finish");

    let s = sign_in_state(&inv).await;
    back(&h, &format!("state={s}&code=not-a-code"))
        .await
        .says(400, "This sign-in wasn’t accepted");
    let s = sign_in_state(&inv).await;
    back(&h, &format!("state={s}&code=breaks-cloud"))
        .await
        .says(502, "Tessera Cloud had a problem");
    assert_eq!(settled(&h).await["phase"], "signed_out");

    let s = sign_in_state(&inv).await;
    back(&h, &format!("state={s}&code=good"))
        .await
        .says(200, "You’re signed in");
    assert_eq!(settled(&h).await["phase"], "signed_in");
    back(&h, &format!("state={s}&code=good"))
        .await
        .says(400, "This sign-in link has expired");

    let other = Page::of(
        http(
            h.port,
            "GET /healthz HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n",
        )
        .await,
    );
    assert_eq!(
        other.header("content-security-policy"),
        ["frame-ancestors 'none'"]
    );
    h.shutdown().await.unwrap();

    let (_keyring, secrets) = keychain();
    let h = start(Some("http://127.0.0.1:9".into()), secrets, clock()).await;
    settled(&h).await;
    let s = sign_in_state(&h.state.invoker).await;
    back(&h, &format!("state={s}&code=good"))
        .await
        .says(502, "Tessera Cloud can’t be reached");
    assert_eq!(settled(&h).await["signingIn"], false);
    h.shutdown().await.unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn each_start_rotates_the_kept_session_and_checks_in_after_hello() {
    let cloud = Cloud::new();
    let base = serve(&cloud).await;
    let (keyring, secrets) = keychain();
    keyring
        .set(
            SESSION_KEY,
            &json!({
                "refresh_token": "r0",
                "user": {"id": "usr_1", "email": "trader@example.test", "name": null},
                "access": "pending",
                "entitlements": [],
                "verified_at": 1,
            })
            .to_string(),
        )
        .unwrap();
    *cloud.refresh.lock().unwrap() = "r0".into();
    *cloud.standing.lock().unwrap() = "full";
    let h = start(Some(base), secrets.clone(), clock()).await;
    let s = settled(&h).await;
    assert_eq!(s["phase"], "signed_in");
    assert_eq!(
        s["access"], "full",
        "Cloud's answer replaces the last known"
    );
    assert_eq!(s["entitlements"], json!(["early_access"]));
    assert_eq!(s["offline"], false);
    let k = kept(&keyring).unwrap();
    assert_eq!(k["refresh_token"], "r1", "the rotated token is kept");
    assert_eq!(k["access"], "full");
    assert!(
        cloud.checkins.lock().unwrap().is_empty(),
        "not before hello"
    );

    let mut ws = Client::new(&h).await;
    let hello = json!({"client": {"name": "tessera-desktop", "version": "0.2.0-alpha.12", "platform": "tauri"}});
    ws.ok("session.hello", hello.clone()).await;
    let checked_in = || {
        (
            cloud.checkins.lock().unwrap().len(),
            h.state.account.checking_in(),
        )
    };
    settle("the first hello checks in", checked_in, |&(n, busy)| {
        n == 1 && !busy
    })
    .await;
    ws.ok("session.hello", hello).await;
    settle(
        "a second hello's check-in, if any, ends",
        checked_in,
        |&(_, busy)| !busy,
    )
    .await;
    let checkins = cloud.checkins.lock().unwrap().clone();
    assert_eq!(checkins.len(), 1, "{checkins:?}");
    assert_eq!(checkins[0]["app_version"], "0.2.0-alpha.12");
    assert_eq!(checkins[0]["channel"], "dev");
    assert_eq!(checkins[0]["arch"], std::env::consts::ARCH);

    let sub = ws
        .ok("subscribe", json!({"topic": "account", "params": {}}))
        .await["subscriptionId"]
        .as_str()
        .unwrap()
        .to_owned();
    let first = ws.event(&sub, |_| true).await;
    assert_eq!(first["data"]["access"], "full");

    let out = user(&h.state.invoker, "account.sign_out", json!({}))
        .await
        .unwrap();
    assert_eq!(out["phase"], "signed_out");
    assert_eq!(cloud.signed_out.load(Ordering::SeqCst), 1);
    assert_eq!(kept(&keyring), None);
    let ev = ws.event(&sub, |p| p["data"]["phase"] == "signed_out").await;
    assert_eq!(ev["data"]["user"], Value::Null);
    h.shutdown().await.unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn offline_keeps_the_last_known_access_and_only_a_refusal_signs_out() {
    let (keyring, secrets) = keychain();
    let session = json!({
        "refresh_token": "r0",
        "user": {"id": "usr_1", "email": "trader@example.test", "name": null},
        "access": "full",
        "entitlements": ["early_access"],
        "verified_at": 1,
    })
    .to_string();
    keyring.set(SESSION_KEY, &session).unwrap();

    let h = start(Some("http://127.0.0.1:9".into()), secrets.clone(), clock()).await;
    let s = settled(&h).await;
    assert_eq!(s["phase"], "signed_in");
    assert_eq!(s["access"], "full");
    assert_eq!(s["offline"], true);
    assert_eq!(s["verifiedAt"], 1);
    assert_eq!(kept(&keyring).unwrap()["refresh_token"], "r0");
    let s = user(&h.state.invoker, "account.status", json!({"check": true}))
        .await
        .unwrap();
    assert_eq!(
        (s["phase"].clone(), s["access"].clone()),
        (json!("signed_in"), json!("full"))
    );
    h.shutdown().await.unwrap();

    let cloud = Cloud::new();
    *cloud.refresh.lock().unwrap() = "r-other".into();
    let base = serve(&cloud).await;
    let h = start(Some(base), secrets, clock()).await;
    let s = settled(&h).await;
    assert_eq!(s["phase"], "signed_out");
    assert!(
        s["problem"].as_str().unwrap().contains("Sign in again"),
        "{s}"
    );
    assert_eq!(kept(&keyring), None);
    h.shutdown().await.unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_kept_sign_in_the_keychain_does_not_give_is_not_a_sign_out() {
    let cloud = Cloud::new();
    let base = serve(&cloud).await;
    let keychain = Keychain::new();
    keychain
        .build("build-1")
        .set(
            SESSION_KEY,
            &json!({
                "refresh_token": "r0",
                "user": {"id": "usr_1", "email": "trader@example.test", "name": null},
                "access": "full",
                "entitlements": ["early_access"],
                "verified_at": 1,
            })
            .to_string(),
        )
        .unwrap();
    *cloud.refresh.lock().unwrap() = "r0".into();
    *cloud.standing.lock().unwrap() = "full";
    keychain.answer(Answer::Deny);
    let secrets = Secrets::with_stores(
        Some(keychain.build("build-2")),
        Some(Arc::new(MemoryStore::new(CredentialStore::DevFile))),
    )
    .without_fallback();
    let h = start(Some(base), secrets, clock()).await;
    let s = settled(&h).await;
    assert_eq!(s["phase"], "unreadable", "{s}");
    assert!(
        s["problem"].as_str().unwrap().contains("cannot be read"),
        "{s}"
    );
    assert_eq!(keychain.builds(SESSION_KEY), vec!["build-1".to_owned()]);
    assert!(
        cloud.verifiers.lock().unwrap().is_empty(),
        "no sign-in began"
    );

    keychain.answer(Answer::Allow);
    let s = user(&h.state.invoker, "account.status", json!({"check": true}))
        .await
        .unwrap();
    assert_eq!(s["phase"], "signed_in", "{s}");
    assert_eq!(s["access"], "full");
    assert_eq!(s["user"]["email"], "trader@example.test");
    h.shutdown().await.unwrap();
}
