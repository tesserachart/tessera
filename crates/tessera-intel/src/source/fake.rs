use std::sync::Arc;

use async_trait::async_trait;
use parking_lot::Mutex;
use serde_json::Value;

use super::http::{HttpClient, HttpError, HttpRequest, HttpResponse};

#[derive(Default)]
pub(crate) struct FakeHttp {
    routes: Mutex<Vec<(String, Result<HttpResponse, HttpError>)>>,
    calls: Mutex<Vec<HttpRequest>>,
}

impl FakeHttp {
    pub(crate) fn new() -> Arc<Self> {
        Arc::new(Self::default())
    }

    pub(crate) fn route(&self, suffix: &str, status: u16, body: &Value) {
        self.answer(
            suffix,
            Ok(HttpResponse {
                status,
                body: serde_json::to_vec(body).unwrap(),
            }),
        );
    }

    pub(crate) fn answer(&self, suffix: &str, reply: Result<HttpResponse, HttpError>) {
        let mut r = self.routes.lock();
        r.retain(|(s, _)| s != suffix);
        r.push((suffix.to_owned(), reply));
    }

    pub(crate) fn calls_to(&self, suffix: &str) -> usize {
        self.calls
            .lock()
            .iter()
            .filter(|c| c.url.ends_with(suffix))
            .count()
    }

    pub(crate) fn calls(&self) -> Vec<HttpRequest> {
        self.calls.lock().clone()
    }
}

#[async_trait]
impl HttpClient for FakeHttp {
    async fn get(&self, req: HttpRequest) -> Result<HttpResponse, HttpError> {
        self.calls.lock().push(req.clone());
        self.routes
            .lock()
            .iter()
            .find(|(s, _)| req.url.ends_with(s.as_str()))
            .map(|(_, r)| r.clone())
            .unwrap_or(Ok(HttpResponse {
                status: 404,
                body: b"{\"error\":\"no route\"}".to_vec(),
            }))
    }
}
