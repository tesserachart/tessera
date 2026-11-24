use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};

use async_trait::async_trait;
use serde_json::{Value, json};
use tessera_intel::source::http::{HttpClient, HttpError, HttpRequest, HttpResponse};

pub const GOOD_KEY: &str = "demo";
pub const SOURCE_ID: &str = "acme";

pub fn spec() -> Value {
    json!({
        "version": 1,
        "id": SOURCE_ID,
        "name": "Acme levels",
        "vendor": "Acme",
        "baseUrl": "https://api.acme.test",
        "auth": {"in": "header", "name": "Authorization", "prefix": "Bearer "},
        "instruments": [
            {"root": "NQ", "ticker": "NDX", "convert": {"model": "request", "path": "/conversion",
             "query": {"ticker": "{ticker}", "future": "{root}"}, "multiplier": "multiplier",
             "additive": "additive", "contract": "future_contract", "method": "additive"}}
        ],
        "requests": [{
            "id": "gamma", "package": "Gamma", "path": "/levels/{ticker}",
            "asOf": {"path": "timestamp"}, "spot": "spot", "group": "gamma",
            "fields": [
                {"field": "zero_gamma", "label": "Zero Gamma", "short": "ZG", "naIf": [0]},
                {"field": "major_pos_vol", "label": "Major Positive Volume", "short": "MPV", "naIf": [0]},
                {"field": "major_neg_vol", "label": "Major Negative Volume", "short": "MNV", "naIf": [0]}
            ]
        }],
        "schedule": {"everySeconds": 60}
    })
}

pub fn vendors() -> Option<Arc<dyn HttpClient>> {
    Some(Arc::new(Vendors))
}

#[derive(Debug)]
struct Vendors;

fn answer(status: u16, body: &Value) -> Result<HttpResponse, HttpError> {
    Ok(HttpResponse {
        status,
        body: serde_json::to_vec(body).unwrap_or_default(),
    })
}

fn seconds_now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |d| d.as_secs())
}

fn ndx_levels() -> Value {
    json!({
        "timestamp": seconds_now(),
        "ticker": "NDX",
        "spot": 20598.4,
        "zero_gamma": 20610,
        "major_pos_vol": 20850,
        "major_neg_vol": 20300
    })
}

#[async_trait]
impl HttpClient for Vendors {
    async fn get(&self, req: HttpRequest) -> Result<HttpResponse, HttpError> {
        let key = req
            .headers
            .iter()
            .find(|(name, _)| name == "Authorization")
            .and_then(|(_, value)| value.strip_prefix("Bearer "));
        if key != Some(GOOD_KEY) {
            return answer(401, &json!({"error": "unauthorized"}));
        }
        let url = req.url.as_str();
        if url.ends_with("/levels/NDX") {
            answer(200, &ndx_levels())
        } else if url.ends_with("/conversion") {
            answer(
                200,
                &json!({"future_contract": "NQZ6", "multiplier": 1, "additive": 42.85}),
            )
        } else {
            answer(404, &json!({"error": "no data for that ticker"}))
        }
    }
}
