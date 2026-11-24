use std::sync::Arc;
use std::time::Duration;

use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use tessera_http::reqwest;
use tessera_http::reqwest::Method;
use tokio::sync::Mutex;

const REQUEST_TIMEOUT: Duration = Duration::from_secs(15);

const FEEDBACK_TIMEOUT: Duration = Duration::from_secs(90);

const SHARE_TIMEOUT: Duration = Duration::from_secs(90);

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct CloudUser {
    pub id: String,
    pub email: String,
    #[serde(default)]
    pub name: Option<String>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Access {
    Full,
    Pending,
    Declined,
    #[serde(other)]
    None,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct CloudAccount {
    pub user: CloudUser,
    pub access: Access,
    #[serde(default)]
    pub entitlements: Vec<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct Checkin {
    pub app_version: String,
    pub platform: String,
    pub arch: String,
    pub channel: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct FeedbackContextItem {
    pub key: String,
    pub label: String,
    pub value: String,
    #[serde(default)]
    pub detail: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct FeedbackScreenshot {
    #[serde(rename = "type")]
    pub mime_type: String,
    pub data: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct FeedbackReport {
    pub id: String,
    pub kind: String,
    pub title: String,
    pub text: String,
    #[serde(default)]
    pub steps: Vec<String>,
    #[serde(default)]
    pub expected: Option<String>,
    #[serde(default)]
    pub actual: Option<String>,
    #[serde(default)]
    pub written_up: bool,
    #[serde(default)]
    pub context: Vec<FeedbackContextItem>,
    #[serde(default)]
    pub screenshot: Option<FeedbackScreenshot>,
    pub app_version: String,
    pub created_at: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct FiledIssue {
    pub number: u64,
    pub url: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct ShareImage {
    #[serde(rename = "type")]
    pub mime_type: String,
    pub data: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct NewShare {
    pub kind: String,
    pub title: String,
    pub image: ShareImage,
    pub width: u32,
    pub height: u32,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct SharedLink {
    pub id: String,
    pub url: String,
    pub kind: String,
    pub title: String,
    pub created_at: String,
}

#[derive(Deserialize)]
struct SharesAnswer {
    shares: Vec<SharedLink>,
}

#[derive(Deserialize)]
struct FeedbackAnswer {
    issue: FiledIssue,
}

#[derive(Clone, Debug, PartialEq, Eq, thiserror::Error)]
pub enum CloudError {
    #[error("not signed in")]
    SignedOut,
    #[error("Tessera Cloud ended the session: sign in again")]
    Rejected,
    #[error("Tessera Cloud can’t be reached ({0})")]
    Unreachable(String),
    #[error("Tessera Cloud answered {status}{}", code.as_deref().map(|c| format!(" ({c})")).unwrap_or_default())]
    Server { status: u16, code: Option<String> },
    #[error("Tessera Cloud’s answer could not be read: {0}")]
    Invalid(String),
}

impl CloudError {
    pub fn needs_sign_in(&self) -> bool {
        matches!(self, CloudError::SignedOut | CloudError::Rejected)
    }

    pub fn is_unreachable(&self) -> bool {
        matches!(self, CloudError::Unreachable(_))
    }

    pub fn is_final(&self) -> bool {
        matches!(self, CloudError::Server { status, .. } if (400..500).contains(status) && !matches!(status, 401 | 408 | 425 | 429))
    }
}

#[async_trait]
pub trait SessionSink: Send + Sync + 'static {
    async fn renewed(&self, refresh_token: &str, account: &CloudAccount);
    async fn rejected(&self);
}

#[derive(Default)]
struct Tokens {
    access: Option<String>,
    refresh: Option<String>,
}

#[derive(Deserialize)]
struct SessionAnswer {
    access_token: String,
    refresh_token: String,
    account: CloudAccount,
}

struct Answer {
    status: u16,
    body: Vec<u8>,
}

impl Answer {
    fn ok(&self) -> bool {
        (200..300).contains(&self.status)
    }

    fn error(&self) -> CloudError {
        #[derive(Deserialize)]
        struct Body {
            error: String,
        }
        let code = serde_json::from_slice::<Body>(&self.body)
            .ok()
            .map(|b| b.error);
        CloudError::Server {
            status: self.status,
            code,
        }
    }

    fn json<T: for<'de> Deserialize<'de>>(&self) -> Result<T, CloudError> {
        serde_json::from_slice(&self.body).map_err(|e| CloudError::Invalid(e.to_string()))
    }
}

pub struct CloudClient {
    base: String,
    http: reqwest::Client,
    sink: Arc<dyn SessionSink>,
    tokens: Mutex<Tokens>,
}

impl std::fmt::Debug for CloudClient {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("CloudClient")
            .field("base", &self.base)
            .finish_non_exhaustive()
    }
}

fn encode(v: &str) -> String {
    let mut out = String::with_capacity(v.len());
    for b in v.bytes() {
        if b.is_ascii_alphanumeric() || matches!(b, b'-' | b'.' | b'_' | b'~') {
            out.push(char::from(b));
        } else {
            out.push_str(&format!("%{b:02X}"));
        }
    }
    out
}

impl CloudClient {
    pub fn new(
        base: impl Into<String>,
        user_agent: &str,
        sink: Arc<dyn SessionSink>,
    ) -> Result<Self, CloudError> {
        let http = tessera_http::client(user_agent, Some(REQUEST_TIMEOUT))
            .map_err(CloudError::Unreachable)?;
        Ok(Self {
            base: base.into().trim_end_matches('/').to_owned(),
            http,
            sink,
            tokens: Mutex::new(Tokens::default()),
        })
    }

    pub fn base(&self) -> &str {
        &self.base
    }

    pub fn start_url(&self, redirect_uri: &str, state: &str, code_challenge: &str) -> String {
        format!(
            "{}/auth/desktop/start?redirect_uri={}&state={}&code_challenge={}",
            self.base,
            encode(redirect_uri),
            encode(state),
            encode(code_challenge)
        )
    }

    pub async fn restore(&self, refresh_token: String) {
        *self.tokens.lock().await = Tokens {
            access: None,
            refresh: Some(refresh_token),
        };
    }

    pub async fn forget(&self) {
        *self.tokens.lock().await = Tokens::default();
    }

    pub async fn has_session(&self) -> bool {
        self.tokens.lock().await.refresh.is_some()
    }

    async fn send(
        &self,
        method: Method,
        path: &str,
        body: Option<&serde_json::Value>,
        bearer: Option<&str>,
        timeout: Duration,
    ) -> Result<Answer, CloudError> {
        let url = format!("{}{path}", self.base);
        let mut b = self
            .http
            .request(method, &url)
            .timeout(timeout)
            .header("accept", "application/json");
        if let Some(t) = bearer {
            b = b.header("authorization", format!("Bearer {t}"));
        }
        if let Some(body) = body {
            b = b
                .header("content-type", "application/json")
                .body(body.to_string());
        }
        let resp = b
            .send()
            .await
            .map_err(|e| CloudError::Unreachable(tessera_http::error_words(e)))?;
        let status = resp.status().as_u16();
        let body = resp
            .bytes()
            .await
            .map_err(|e| CloudError::Unreachable(tessera_http::error_words(e)))?;
        Ok(Answer {
            status,
            body: body.to_vec(),
        })
    }

    async fn take(&self, tokens: &mut Tokens, answer: &Answer) -> Result<CloudAccount, CloudError> {
        let s: SessionAnswer = answer.json()?;
        self.sink.renewed(&s.refresh_token, &s.account).await;
        tokens.access = Some(s.access_token);
        tokens.refresh = Some(s.refresh_token);
        Ok(s.account)
    }

    pub async fn exchange(&self, code: &str, verifier: &str) -> Result<CloudAccount, CloudError> {
        let body = serde_json::json!({ "code": code, "code_verifier": verifier });
        let mut tokens = self.tokens.lock().await;
        let a = self
            .send(
                Method::POST,
                "/v1/auth/token",
                Some(&body),
                None,
                REQUEST_TIMEOUT,
            )
            .await?;
        match a.status {
            401 => Err(CloudError::Rejected),
            _ if a.ok() => self.take(&mut tokens, &a).await,
            _ => Err(a.error()),
        }
    }

    async fn refresh_locked(&self, tokens: &mut Tokens) -> Result<CloudAccount, CloudError> {
        let Some(refresh) = tokens.refresh.clone() else {
            return Err(CloudError::SignedOut);
        };
        let body = serde_json::json!({ "refresh_token": refresh });
        let a = self
            .send(
                Method::POST,
                "/v1/auth/refresh",
                Some(&body),
                None,
                REQUEST_TIMEOUT,
            )
            .await?;
        if a.status == 401 {
            *tokens = Tokens::default();
            self.sink.rejected().await;
            return Err(CloudError::Rejected);
        }
        if !a.ok() {
            return Err(a.error());
        }
        self.take(tokens, &a).await
    }

    pub async fn refresh(&self) -> Result<CloudAccount, CloudError> {
        let mut tokens = self.tokens.lock().await;
        self.refresh_locked(&mut tokens).await
    }

    async fn access(&self) -> Result<String, CloudError> {
        let mut tokens = self.tokens.lock().await;
        if let Some(t) = &tokens.access {
            return Ok(t.clone());
        }
        self.refresh_locked(&mut tokens).await?;
        tokens.access.clone().ok_or(CloudError::SignedOut)
    }

    async fn access_after(&self, refused: &str) -> Result<String, CloudError> {
        let mut tokens = self.tokens.lock().await;
        if let Some(t) = &tokens.access
            && t != refused
        {
            return Ok(t.clone());
        }
        tokens.access = None;
        self.refresh_locked(&mut tokens).await?;
        tokens.access.clone().ok_or(CloudError::SignedOut)
    }

    async fn authed(
        &self,
        method: Method,
        path: &str,
        body: Option<&serde_json::Value>,
        timeout: Duration,
    ) -> Result<Answer, CloudError> {
        let token = self.access().await?;
        let a = self
            .send(method.clone(), path, body, Some(&token), timeout)
            .await?;
        if a.status != 401 {
            return Ok(a);
        }
        let token = self.access_after(&token).await?;
        self.send(method, path, body, Some(&token), timeout).await
    }

    pub async fn me(&self) -> Result<CloudAccount, CloudError> {
        let a = self
            .authed(Method::GET, "/v1/me", None, REQUEST_TIMEOUT)
            .await?;
        if a.ok() { a.json() } else { Err(a.error()) }
    }

    pub async fn checkin(&self, checkin: &Checkin) -> Result<(), CloudError> {
        let body = serde_json::to_value(checkin).map_err(|e| CloudError::Invalid(e.to_string()))?;
        let a = self
            .authed(Method::POST, "/v1/checkins", Some(&body), REQUEST_TIMEOUT)
            .await?;
        if a.ok() { Ok(()) } else { Err(a.error()) }
    }

    pub async fn feedback(&self, report: &FeedbackReport) -> Result<FiledIssue, CloudError> {
        let body = serde_json::to_value(report).map_err(|e| CloudError::Invalid(e.to_string()))?;
        let a = self
            .authed(Method::POST, "/v1/feedback", Some(&body), FEEDBACK_TIMEOUT)
            .await?;
        if a.ok() {
            a.json::<FeedbackAnswer>().map(|f| f.issue)
        } else {
            Err(a.error())
        }
    }

    pub async fn create_share(&self, share: &NewShare) -> Result<SharedLink, CloudError> {
        let body = serde_json::to_value(share).map_err(|e| CloudError::Invalid(e.to_string()))?;
        let a = self
            .authed(Method::POST, "/v1/shares", Some(&body), SHARE_TIMEOUT)
            .await?;
        if a.ok() { a.json() } else { Err(a.error()) }
    }

    pub async fn shares(&self) -> Result<Vec<SharedLink>, CloudError> {
        let a = self
            .authed(Method::GET, "/v1/shares", None, REQUEST_TIMEOUT)
            .await?;
        if a.ok() {
            a.json::<SharesAnswer>().map(|s| s.shares)
        } else {
            Err(a.error())
        }
    }

    pub async fn delete_share(&self, id: &str) -> Result<(), CloudError> {
        let path = format!("/v1/shares/{}", encode(id));
        let a = self
            .authed(Method::DELETE, &path, None, REQUEST_TIMEOUT)
            .await?;
        if a.ok() { Ok(()) } else { Err(a.error()) }
    }

    pub async fn sign_out(&self) -> Result<(), CloudError> {
        let held = self.tokens.lock().await.access.clone();
        let r = match held {
            Some(token) => match self
                .send(
                    Method::POST,
                    "/v1/auth/sign-out",
                    None,
                    Some(&token),
                    REQUEST_TIMEOUT,
                )
                .await
            {
                Ok(a) if a.ok() => Ok(()),
                Ok(a) => Err(a.error()),
                Err(e) => Err(e),
            },
            None => Err(CloudError::SignedOut),
        };
        self.forget().await;
        r
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Mutex as StdMutex;
    use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};

    use axum::Router;
    use axum::extract::State;
    use axum::http::{HeaderMap, StatusCode};
    use axum::response::{IntoResponse, Response};
    use axum::routing::{get, post};
    use serde_json::{Value, json};

    use super::*;

    struct Fake {
        n: StdMutex<usize>,
        access: StdMutex<String>,
        refresh: StdMutex<String>,
        standing: StdMutex<&'static str>,
        refreshes: AtomicUsize,
        checkins: AtomicUsize,
        signed_out: AtomicUsize,
        down: AtomicBool,
        shares: StdMutex<Vec<Value>>,
    }

    impl Fake {
        fn new() -> Arc<Self> {
            Arc::new(Self {
                n: StdMutex::new(0),
                access: StdMutex::new(String::new()),
                refresh: StdMutex::new("r0".into()),
                standing: StdMutex::new("pending"),
                refreshes: AtomicUsize::new(0),
                checkins: AtomicUsize::new(0),
                signed_out: AtomicUsize::new(0),
                down: AtomicBool::new(false),
                shares: StdMutex::new(Vec::new()),
            })
        }

        fn account(&self) -> Value {
            json!({
                "user": {"id": "usr_1", "email": "t@example.test", "name": null},
                "access": *self.standing.lock().unwrap(),
                "entitlements": [],
            })
        }

        fn session(&self) -> Value {
            let mut n = self.n.lock().unwrap();
            *n += 1;
            *self.access.lock().unwrap() = format!("a{n}");
            *self.refresh.lock().unwrap() = format!("r{n}");
            json!({"access_token": format!("a{n}"), "refresh_token": format!("r{n}"), "account": self.account()})
        }

        fn expire(&self) {
            self.access.lock().unwrap().clear();
        }

        fn authorized(&self, h: &HeaderMap) -> bool {
            let held = self.access.lock().unwrap().clone();
            !held.is_empty()
                && h.get("authorization").and_then(|v| v.to_str().ok())
                    == Some(format!("Bearer {held}").as_str())
        }
    }

    fn refused() -> Response {
        (StatusCode::UNAUTHORIZED, r#"{"error":"unauthorized"}"#).into_response()
    }

    fn rejected() -> Response {
        (StatusCode::UNAUTHORIZED, r#"{"error":"rejected"}"#).into_response()
    }

    async fn token(State(f): State<Arc<Fake>>, body: String) -> Response {
        let v: Value = serde_json::from_str(&body).unwrap();
        if v["code"] != "good" || v["code_verifier"].as_str().is_none_or(|s| s.len() < 43) {
            return rejected();
        }
        axum::Json(f.session()).into_response()
    }

    async fn refresh(State(f): State<Arc<Fake>>, body: String) -> Response {
        if f.down.load(Ordering::SeqCst) {
            return (StatusCode::BAD_GATEWAY, "").into_response();
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
        f.refreshes.fetch_add(1, Ordering::SeqCst);
        let v: Value = serde_json::from_str(&body).unwrap();
        if v["refresh_token"] != *f.refresh.lock().unwrap() {
            return rejected();
        }
        axum::Json(f.session()).into_response()
    }

    async fn me(State(f): State<Arc<Fake>>, h: HeaderMap) -> Response {
        if !f.authorized(&h) {
            return refused();
        }
        axum::Json(f.account()).into_response()
    }

    async fn checkins(State(f): State<Arc<Fake>>, h: HeaderMap, body: String) -> Response {
        if !f.authorized(&h) {
            return refused();
        }
        let v: Value = serde_json::from_str(&body).unwrap();
        assert_eq!(v["platform"], "linux");
        assert_eq!(v["app_version"], "0.2.0-alpha.7");
        f.checkins.fetch_add(1, Ordering::SeqCst);
        StatusCode::NO_CONTENT.into_response()
    }

    async fn feedback(State(f): State<Arc<Fake>>, h: HeaderMap, body: String) -> Response {
        if !f.authorized(&h) {
            return refused();
        }
        let v: Value = serde_json::from_str(&body).unwrap();
        if v["kind"] == "nonsense" {
            return (StatusCode::BAD_REQUEST, r#"{"error":"bad_request"}"#).into_response();
        }
        if v["kind"] == "later" {
            return (
                StatusCode::SERVICE_UNAVAILABLE,
                r#"{"error":"feedback_off"}"#,
            )
                .into_response();
        }
        assert_eq!(v["screenshot"]["type"], "image/png");
        assert_eq!(v["context"][0]["key"], "app");
        axum::Json(
            json!({"id": v["id"], "issue": {"number": 41, "url": "https://example.test/i/41"}}),
        )
        .into_response()
    }

    async fn create_share(State(f): State<Arc<Fake>>, h: HeaderMap, body: String) -> Response {
        if !f.authorized(&h) {
            return refused();
        }
        let v: Value = serde_json::from_str(&body).unwrap();
        assert_eq!(v["image"]["type"], "image/png");
        let mut shares = f.shares.lock().unwrap();
        let id = format!("Ab3dE6gH9jK{}", shares.len());
        let link = json!({
            "id": id, "url": format!("https://account.example.test/s/{id}"),
            "kind": v["kind"], "title": v["title"], "created_at": "2026-11-23T10:00:00.000Z",
        });
        shares.insert(0, link.clone());
        (StatusCode::CREATED, axum::Json(link)).into_response()
    }

    async fn list_shares(State(f): State<Arc<Fake>>, h: HeaderMap) -> Response {
        if !f.authorized(&h) {
            return refused();
        }
        axum::Json(json!({"shares": *f.shares.lock().unwrap()})).into_response()
    }

    async fn delete_share(
        State(f): State<Arc<Fake>>,
        h: HeaderMap,
        axum::extract::Path(id): axum::extract::Path<String>,
    ) -> Response {
        if !f.authorized(&h) {
            return refused();
        }
        let mut shares = f.shares.lock().unwrap();
        let before = shares.len();
        shares.retain(|s| s["id"] != id.as_str());
        if shares.len() == before {
            return (StatusCode::NOT_FOUND, r#"{"error":"not_found"}"#).into_response();
        }
        StatusCode::NO_CONTENT.into_response()
    }

    async fn sign_out(State(f): State<Arc<Fake>>, h: HeaderMap) -> Response {
        if !f.authorized(&h) {
            return refused();
        }
        f.signed_out.fetch_add(1, Ordering::SeqCst);
        StatusCode::NO_CONTENT.into_response()
    }

    async fn serve(fake: Arc<Fake>) -> String {
        let app = Router::new()
            .route("/v1/auth/token", post(token))
            .route("/v1/auth/refresh", post(refresh))
            .route("/v1/me", get(me))
            .route("/v1/checkins", post(checkins))
            .route("/v1/shares", post(create_share).get(list_shares))
            .route("/v1/shares/{id}", axum::routing::delete(delete_share))
            .route("/v1/auth/sign-out", post(sign_out))
            .route("/v1/feedback", post(feedback))
            .with_state(fake);
        let l = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = l.local_addr().unwrap().port();
        tokio::spawn(async move { axum::serve(l, app).await.unwrap() });
        format!("http://127.0.0.1:{port}")
    }

    #[derive(Default)]
    struct Kept(StdMutex<Vec<String>>);

    #[async_trait]
    impl SessionSink for Kept {
        async fn renewed(&self, refresh_token: &str, account: &CloudAccount) {
            self.0
                .lock()
                .unwrap()
                .push(format!("{refresh_token} {:?}", account.access));
        }
        async fn rejected(&self) {
            self.0.lock().unwrap().push("rejected".into());
        }
    }

    impl Kept {
        fn said(&self) -> Vec<String> {
            self.0.lock().unwrap().clone()
        }
    }

    async fn client(fake: &Arc<Fake>) -> (Arc<CloudClient>, Arc<Kept>) {
        let base = serve(Arc::clone(fake)).await;
        let kept = Arc::new(Kept::default());
        let c = CloudClient::new(base, "Tessera/test", Arc::clone(&kept) as _).unwrap();
        (Arc::new(c), kept)
    }

    fn checkin() -> Checkin {
        Checkin {
            app_version: "0.2.0-alpha.7".into(),
            platform: "linux".into(),
            arch: "x86_64".into(),
            channel: "release".into(),
        }
    }

    const VERIFIER: &str = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";

    #[tokio::test]
    async fn a_sign_in_keeps_the_session_and_each_refresh_rotates_it() {
        let fake = Fake::new();
        let (c, kept) = client(&fake).await;
        assert_eq!(c.me().await, Err(CloudError::SignedOut));
        assert_eq!(c.exchange("bad", VERIFIER).await, Err(CloudError::Rejected));
        let a = c.exchange("good", VERIFIER).await.unwrap();
        assert_eq!(a.access, Access::Pending);
        assert_eq!(a.user.email, "t@example.test");
        assert_eq!(kept.said(), ["r1 Pending"]);
        assert_eq!(c.me().await.unwrap().access, Access::Pending);
        assert_eq!(fake.refreshes.load(Ordering::SeqCst), 0);
        *fake.standing.lock().unwrap() = "full";
        assert_eq!(c.refresh().await.unwrap().access, Access::Full);
        assert_eq!(kept.said(), ["r1 Pending", "r2 Full"]);
        c.refresh().await.unwrap();
        assert_eq!(kept.said(), ["r1 Pending", "r2 Full", "r3 Full"]);
        c.checkin(&checkin()).await.unwrap();
        assert_eq!(fake.checkins.load(Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn an_expired_access_token_is_refreshed_once_for_every_caller() {
        let fake = Fake::new();
        let (c, kept) = client(&fake).await;
        c.restore("r0".into()).await;
        let calls: Vec<_> = (0..5)
            .map(|_| {
                let c = Arc::clone(&c);
                tokio::spawn(async move { c.me().await })
            })
            .collect();
        for call in calls {
            assert_eq!(call.await.unwrap().unwrap().access, Access::Pending);
        }
        assert_eq!(fake.refreshes.load(Ordering::SeqCst), 1, "one refresh");
        assert_eq!(kept.said(), ["r1 Pending"]);

        fake.expire();
        let calls: Vec<_> = (0..5)
            .map(|_| {
                let c = Arc::clone(&c);
                tokio::spawn(async move { c.checkin(&checkin()).await })
            })
            .collect();
        for call in calls {
            call.await.unwrap().unwrap();
        }
        assert_eq!(fake.refreshes.load(Ordering::SeqCst), 2, "one more refresh");
        assert_eq!(fake.checkins.load(Ordering::SeqCst), 5);
        assert_eq!(kept.said(), ["r1 Pending", "r2 Pending"]);
    }

    #[tokio::test]
    async fn a_rejected_refresh_ends_the_session_and_being_offline_changes_nothing() {
        let fake = Fake::new();
        let (c, kept) = client(&fake).await;
        c.restore("r0".into()).await;
        fake.down.store(true, Ordering::SeqCst);
        let e = c.me().await.unwrap_err();
        assert!(!e.needs_sign_in() && !e.is_unreachable(), "{e}");
        assert!(c.has_session().await);
        let gone =
            CloudClient::new("http://127.0.0.1:9", "Tessera/test", Arc::clone(&kept) as _).unwrap();
        gone.restore("r0".into()).await;
        let e = gone.me().await.unwrap_err();
        assert!(e.is_unreachable(), "{e}");
        assert!(gone.has_session().await);
        assert!(kept.said().is_empty(), "nothing changed");
        fake.down.store(false, Ordering::SeqCst);
        c.restore("r-old".into()).await;
        assert_eq!(c.me().await, Err(CloudError::Rejected));
        assert!(!c.has_session().await);
        assert_eq!(kept.said(), ["rejected"]);
    }

    #[tokio::test]
    async fn signing_out_revokes_with_the_held_token_and_forgets() {
        let fake = Fake::new();
        let (c, _kept) = client(&fake).await;
        c.exchange("good", VERIFIER).await.unwrap();
        c.sign_out().await.unwrap();
        assert_eq!(fake.signed_out.load(Ordering::SeqCst), 1);
        assert!(!c.has_session().await);
        c.restore("r1".into()).await;
        assert_eq!(c.sign_out().await, Err(CloudError::SignedOut));
        assert_eq!(fake.refreshes.load(Ordering::SeqCst), 0);
        assert!(!c.has_session().await);
    }

    fn report(kind: &str) -> FeedbackReport {
        FeedbackReport {
            id: "fb-0123456789".into(),
            kind: kind.into(),
            title: "The DOM froze".into(),
            text: "It froze after a fill".into(),
            steps: vec!["Buy 1".into()],
            expected: None,
            actual: None,
            written_up: false,
            context: vec![FeedbackContextItem {
                key: "app".into(),
                label: "App".into(),
                value: "0.2.0".into(),
                detail: None,
            }],
            screenshot: Some(FeedbackScreenshot {
                mime_type: "image/png".into(),
                data: "iVBORw0KGgo=".into(),
            }),
            app_version: "0.2.0".into(),
            created_at: "2026-10-02T18:42:00Z".into(),
        }
    }

    #[tokio::test]
    async fn a_report_is_filed_and_a_refusal_says_whether_to_try_again() {
        let fake = Fake::new();
        let (c, _kept) = client(&fake).await;
        assert_eq!(c.feedback(&report("bug")).await, Err(CloudError::SignedOut));
        c.exchange("good", VERIFIER).await.unwrap();
        let filed = c.feedback(&report("bug")).await.unwrap();
        assert_eq!(filed.number, 41);
        let bad = c.feedback(&report("nonsense")).await.unwrap_err();
        assert!(bad.is_final(), "{bad}");
        let later = c.feedback(&report("later")).await.unwrap_err();
        assert!(!later.is_final(), "{later}");
        let gone = CloudClient::new(
            "http://127.0.0.1:9",
            "Tessera/test",
            Arc::new(Kept::default()),
        )
        .unwrap();
        gone.restore("r0".into()).await;
        let e = gone.feedback(&report("bug")).await.unwrap_err();
        assert!(e.is_unreachable() && !e.is_final(), "{e}");
    }

    fn chart_share(title: &str) -> NewShare {
        NewShare {
            kind: "chart".into(),
            title: title.into(),
            image: ShareImage {
                mime_type: "image/png".into(),
                data: "iVBORw0KGgo=".into(),
            },
            width: 1600,
            height: 900,
        }
    }

    #[tokio::test]
    async fn a_share_gets_a_link_is_listed_and_deleting_it_takes_it_away() {
        let fake = Fake::new();
        let (c, _kept) = client(&fake).await;
        assert_eq!(
            c.create_share(&chart_share("NQZ6 · 5m")).await,
            Err(CloudError::SignedOut)
        );
        c.exchange("good", VERIFIER).await.unwrap();
        let first = c.create_share(&chart_share("NQZ6 · 5m")).await.unwrap();
        assert_eq!(
            first.url,
            format!("https://account.example.test/s/{}", first.id)
        );
        let second = c.create_share(&chart_share("ESZ6 · 1m")).await.unwrap();
        fake.expire();
        let listed = c.shares().await.unwrap();
        assert_eq!(listed, vec![second.clone(), first.clone()]);
        c.delete_share(&first.id).await.unwrap();
        assert_eq!(c.shares().await.unwrap(), vec![second]);
        let again = c.delete_share(&first.id).await.unwrap_err();
        assert_eq!(
            again,
            CloudError::Server {
                status: 404,
                code: Some("not_found".into())
            }
        );
    }

    #[test]
    fn the_start_url_carries_the_loopback_redirect_encoded() {
        struct Nothing;
        #[async_trait]
        impl SessionSink for Nothing {
            async fn renewed(&self, _: &str, _: &CloudAccount) {}
            async fn rejected(&self) {}
        }
        let c = CloudClient::new("https://account.example.test/", "t", Arc::new(Nothing)).unwrap();
        assert_eq!(
            c.start_url("http://127.0.0.1:4321/auth/callback", "st_ate", "ch-al"),
            "https://account.example.test/auth/desktop/start?redirect_uri=http%3A%2F%2F127.0.0.1%3A4321%2Fauth%2Fcallback&state=st_ate&code_challenge=ch-al"
        );
    }

    #[test]
    fn an_unknown_access_reads_as_none() {
        let a: CloudAccount = serde_json::from_value(json!({
            "user": {"id": "u", "email": "e"}, "access": "something-new"
        }))
        .unwrap();
        assert_eq!(a.access, Access::None);
        assert!(a.entitlements.is_empty());
        assert_eq!(a.user.name, None);
    }
}
