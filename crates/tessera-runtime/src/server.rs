use std::collections::HashMap;

use axum::Router;
use axum::extract::{Query, State, WebSocketUpgrade};
use axum::http::header::{
    AUTHORIZATION, CACHE_CONTROL, CONTENT_SECURITY_POLICY, CONTENT_TYPE, REFERRER_POLICY,
    X_CONTENT_TYPE_OPTIONS, X_FRAME_OPTIONS,
};
use axum::http::{HeaderMap, HeaderValue, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use serde_json::json;
use tower_http::services::{ServeDir, ServeFile};
use tower_http::set_header::SetResponseHeaderLayer;

use crate::modules::account::CallbackPage;
use crate::state::SharedState;
use crate::ws;

const MAX_MESSAGE: usize = 16 * 1024 * 1024;

pub fn router(state: SharedState) -> Router {
    let mut r = Router::new()
        .route("/healthz", get(healthz))
        .route("/ws", get(ws_upgrade))
        .route(
            "/mcp",
            post(mcp_post).get(mcp_no_stream).delete(mcp_no_stream),
        )
        .route(crate::modules::account::CALLBACK_PATH, get(auth_callback))
        .route("/", get(index));
    r = match &state.ui_dir {
        Some(dir) => {
            r.fallback_service(ServeDir::new(dir).fallback(ServeFile::new(dir.join("index.html"))))
        }
        None => r.fallback(not_found),
    };
    r.layer(SetResponseHeaderLayer::overriding(
        X_CONTENT_TYPE_OPTIONS,
        HeaderValue::from_static("nosniff"),
    ))
    .layer(SetResponseHeaderLayer::overriding(
        X_FRAME_OPTIONS,
        HeaderValue::from_static("DENY"),
    ))
    .layer(SetResponseHeaderLayer::if_not_present(
        CONTENT_SECURITY_POLICY,
        HeaderValue::from_static("frame-ancestors 'none'"),
    ))
    .layer(SetResponseHeaderLayer::overriding(
        REFERRER_POLICY,
        HeaderValue::from_static("no-referrer"),
    ))
    .with_state(state)
}

fn json_response(status: StatusCode, body: serde_json::Value) -> Response {
    (
        status,
        [(CONTENT_TYPE, "application/json")],
        body.to_string(),
    )
        .into_response()
}

fn bearer(headers: &HeaderMap) -> Option<&str> {
    headers
        .get(AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix("Bearer "))
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Refusal {
    Origin,
    Unauthorized,
}

impl IntoResponse for Refusal {
    fn into_response(self) -> Response {
        match self {
            Refusal::Origin => json_response(
                StatusCode::FORBIDDEN,
                json!({ "error": "origin not allowed" }),
            ),
            Refusal::Unauthorized => json_response(
                StatusCode::UNAUTHORIZED,
                json!({ "error": "invalid token" }),
            ),
        }
    }
}

fn authorize(state: &SharedState, headers: &HeaderMap) -> Result<bool, Refusal> {
    if !state.origins.check(headers) {
        tracing::warn!(origin = ?headers.get("origin"), "request refused: origin not allowed");
        return Err(Refusal::Origin);
    }
    match bearer(headers) {
        Some(t) if state.token.matches(t) => Ok(true),
        Some(_) => Err(Refusal::Unauthorized),
        None => Ok(false),
    }
}

async fn healthz(State(state): State<SharedState>) -> Response {
    json_response(
        StatusCode::OK,
        json!({ "status": "ok", "version": state.version }),
    )
}

async fn ws_upgrade(
    State(state): State<SharedState>,
    headers: HeaderMap,
    upgrade: WebSocketUpgrade,
) -> Response {
    let vouched = match authorize(&state, &headers) {
        Ok(vouched) => vouched,
        Err(refusal) => return refusal.into_response(),
    };
    upgrade
        .max_message_size(MAX_MESSAGE)
        .on_upgrade(move |socket| ws::serve(socket, state, vouched))
}

async fn index(State(state): State<SharedState>) -> Response {
    let cache = "no-cache";
    match &state.ui_dir {
        Some(dir) => match tokio::fs::read(dir.join("index.html")).await {
            Ok(bytes) => (
                StatusCode::OK,
                [
                    (CONTENT_TYPE, "text/html; charset=utf-8"),
                    (CACHE_CONTROL, cache),
                ],
                bytes,
            )
                .into_response(),
            Err(e) => {
                tracing::error!(error = %e, "index.html missing in --ui-dir");
                json_response(
                    StatusCode::NOT_FOUND,
                    json!({ "error": "index.html not found in the UI directory" }),
                )
            }
        },
        None => (
            StatusCode::OK,
            [
                (CONTENT_TYPE, "text/plain; charset=utf-8"),
                (CACHE_CONTROL, cache),
            ],
            format!(
                "Tessera runtime {}. No UI is served by this process (start it with --ui-dir).\n",
                state.version
            ),
        )
            .into_response(),
    }
}

async fn auth_callback(
    State(state): State<SharedState>,
    Query(q): Query<HashMap<String, String>>,
) -> Response {
    match state.account.callback(&q).await {
        Some(page) => (
            StatusCode::from_u16(page.status()).unwrap_or(StatusCode::BAD_REQUEST),
            [
                (CONTENT_TYPE, "text/html; charset=utf-8"),
                (CACHE_CONTROL, "no-store"),
                (CONTENT_SECURITY_POLICY, CallbackPage::policy()),
            ],
            page.html(),
        )
            .into_response(),
        None => not_found().await,
    }
}

async fn mcp_no_stream() -> Response {
    json_response(
        StatusCode::METHOD_NOT_ALLOWED,
        json!({ "error": "POST JSON-RPC to /mcp" }),
    )
}

fn mcp_origin(state: &SharedState, token: &str) -> Option<tessera_core::Origin> {
    if let Some(origin) = state.principals.resolve(token) {
        return Some(origin);
    }
    let caller = state.mcp_clients.resolve(token)?;
    state.invoker.set_policy(&caller.origin, caller.policy);
    if caller.new_turn {
        state.invoker.begin_turn(&caller.origin);
    }
    Some(caller.origin)
}

async fn mcp_post(
    State(state): State<SharedState>,
    headers: HeaderMap,
    body: axum::body::Bytes,
) -> Response {
    if headers.contains_key("origin") {
        return json_response(
            StatusCode::FORBIDDEN,
            json!({ "error": "not from a browser" }),
        );
    }
    let origin = headers
        .get(AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix("Bearer "))
        .and_then(|t| mcp_origin(&state, t));
    let Some(origin) = origin else {
        let mut r = json_response(StatusCode::UNAUTHORIZED, json!({ "error": "unauthorized" }));
        r.headers_mut().insert(
            "www-authenticate",
            axum::http::HeaderValue::from_static("Bearer"),
        );
        return r;
    };
    let msg: serde_json::Value = match serde_json::from_slice(&body) {
        Ok(v @ serde_json::Value::Object(_)) => v,
        _ => {
            return json_response(
                StatusCode::BAD_REQUEST,
                json!({"jsonrpc": "2.0", "id": null, "error": {"code": -32700, "message": "one JSON-RPC object"}}),
            );
        }
    };
    match state.mcp.handle(&origin, msg).await {
        Some(answer) => json_response(StatusCode::OK, answer),
        None => StatusCode::ACCEPTED.into_response(),
    }
}

async fn not_found() -> Response {
    json_response(StatusCode::NOT_FOUND, json!({ "error": "not found" }))
}
