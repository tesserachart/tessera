use std::time::Duration;

use async_trait::async_trait;
use tessera_http::reqwest;

#[derive(Clone)]
pub struct HttpRequest {
    pub url: String,
    pub query: Vec<(String, String)>,
    pub headers: Vec<(String, String)>,
    pub timeout: Duration,
}

impl std::fmt::Debug for HttpRequest {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("HttpRequest")
            .field("url", &self.url)
            .field(
                "query",
                &self.query.iter().map(|(k, _)| k).collect::<Vec<_>>(),
            )
            .field(
                "headers",
                &self.headers.iter().map(|(k, _)| k).collect::<Vec<_>>(),
            )
            .finish()
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct HttpResponse {
    pub status: u16,
    pub body: Vec<u8>,
}

#[derive(Clone, Debug, PartialEq, Eq, thiserror::Error)]
pub enum HttpError {
    #[error("no answer within the timeout")]
    Timeout,
    #[error("could not reach it: {0}")]
    Transport(String),
}

#[async_trait]
pub trait HttpClient: Send + Sync + 'static {
    async fn get(&self, req: HttpRequest) -> Result<HttpResponse, HttpError>;
}

#[derive(Clone, Debug)]
pub struct ReqwestClient {
    client: reqwest::Client,
}

impl ReqwestClient {
    pub fn new(user_agent: &str) -> Result<Self, HttpError> {
        let client = tessera_http::client(user_agent, None).map_err(HttpError::Transport)?;
        Ok(Self { client })
    }
}

fn http_error(e: reqwest::Error) -> HttpError {
    if e.is_timeout() {
        HttpError::Timeout
    } else {
        HttpError::Transport(tessera_http::error_words(e))
    }
}

#[async_trait]
impl HttpClient for ReqwestClient {
    async fn get(&self, req: HttpRequest) -> Result<HttpResponse, HttpError> {
        let mut b = self.client.get(&req.url).timeout(req.timeout);
        if !req.query.is_empty() {
            b = b.query(&req.query);
        }
        for (k, v) in &req.headers {
            b = b.header(k, v);
        }
        let resp = b.send().await.map_err(http_error)?;
        let status = resp.status().as_u16();
        let body = resp.bytes().await.map_err(http_error)?;
        Ok(HttpResponse {
            status,
            body: body.to_vec(),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_request_never_shows_its_secret() {
        let r = HttpRequest {
            url: "https://api.example.test/v1/levels".into(),
            query: vec![("apikey".into(), "sekrit-123".into())],
            headers: vec![("Authorization".into(), "Bearer sekrit-456".into())],
            timeout: Duration::from_secs(1),
        };
        let s = format!("{r:?}");
        assert!(!s.contains("sekrit"), "{s}");
        assert!(s.contains("apikey") && s.contains("Authorization"));
    }

    #[tokio::test]
    async fn a_redirect_is_returned_not_followed() {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};

        let elsewhere = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        elsewhere.set_nonblocking(true).unwrap();
        let elsewhere_url = format!("http://{}/stolen", elsewhere.local_addr().unwrap());
        let vendor = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let vendor_url = format!("http://{}/levels", vendor.local_addr().unwrap());
        tokio::spawn(async move {
            let (mut conn, _) = vendor.accept().await.unwrap();
            let mut request = [0u8; 4096];
            let _ = conn.read(&mut request).await.unwrap();
            let reply = format!(
                "HTTP/1.1 302 Found\r\nLocation: {elsewhere_url}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
            );
            conn.write_all(reply.as_bytes()).await.unwrap();
        });

        let resp = ReqwestClient::new("tessera-test")
            .unwrap()
            .get(HttpRequest {
                url: vendor_url,
                query: vec![("apikey".into(), "sekrit-123".into())],
                headers: vec![("Authorization".into(), "Bearer sekrit-456".into())],
                timeout: Duration::from_secs(5),
            })
            .await
            .unwrap();
        assert_eq!(resp.status, 302);
        assert!(
            matches!(elsewhere.accept(), Err(e) if e.kind() == std::io::ErrorKind::WouldBlock),
            "the redirect's target was asked"
        );
    }
}
