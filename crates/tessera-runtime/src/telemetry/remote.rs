use std::collections::BTreeMap;
use std::time::Duration;

use serde_json::{Value, json};
use tessera_http::{error_words, reqwest};

use super::Project;

const EU_ASSETS: &str = "https://eu-assets.i.posthog.com";

const TIMEOUT: Duration = Duration::from_secs(10);

pub struct Remote {
    http: reqwest::Client,
    host: String,
    assets: String,
    key: String,
}

#[derive(Debug)]
pub struct Failed(pub String);

impl Remote {
    pub fn new(project: &Project, key: String) -> Result<Self, Failed> {
        let http = tessera_http::client(
            concat!("tessera-runtime/", env!("CARGO_PKG_VERSION")),
            Some(TIMEOUT),
        )
        .map_err(Failed)?;
        let host = project.host.trim_end_matches('/').to_owned();
        let assets = if host == posthog_rs::EU_INGESTION_ENDPOINT {
            EU_ASSETS.to_owned()
        } else {
            host.clone()
        };
        Ok(Self {
            http,
            host,
            assets,
            key,
        })
    }

    async fn json(&self, req: reqwest::RequestBuilder) -> Result<Value, Failed> {
        let res = req.send().await.map_err(|e| Failed(error_words(e)))?;
        let status = res.status();
        let body = res.bytes().await.map_err(|e| Failed(error_words(e)))?;
        if !status.is_success() {
            return Err(Failed(format!("PostHog answered {status}")));
        }
        serde_json::from_slice(&body).map_err(|e| Failed(e.to_string()))
    }

    fn post(&self, path: &str, body: &Value) -> reqwest::RequestBuilder {
        self.http
            .post(format!("{}{path}", self.host))
            .header("content-type", "application/json")
            .body(body.to_string())
    }

    pub async fn flags(
        &self,
        distinct_id: &str,
        person: &BTreeMap<&str, Value>,
    ) -> Result<BTreeMap<String, Value>, Failed> {
        let body = json!({
            "api_key": self.key,
            "distinct_id": distinct_id,
            "person_properties": person,
            "geoip_disable": true,
        });
        Ok(flag_values(
            &self.json(self.post("/flags/?v=2", &body)).await?,
        ))
    }

    pub async fn config(&self) -> Result<Value, Failed> {
        let url = format!("{}/array/{}/config", self.assets, self.key);
        self.json(self.http.get(url)).await
    }

    pub async fn surveys(&self) -> Result<Vec<Value>, Failed> {
        let url = format!("{}/api/surveys/?token={}", self.host, self.key);
        let v = self.json(self.http.get(url)).await?;
        Ok(v.get("surveys")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default())
    }

    pub async fn recordings(&self, events: Vec<Value>) -> Result<(), Failed> {
        // PostHog's recordings endpoint refuses the `{api_key, batch}` shape: each event carries the token in its properties.
        let events: Vec<Value> = events
            .into_iter()
            .map(|mut e| {
                if let Some(p) = e.get_mut("properties").and_then(Value::as_object_mut) {
                    p.insert("token".into(), json!(self.key));
                }
                e
            })
            .collect();
        self.json(self.post("/s/", &Value::Array(events)))
            .await
            .map(drop)
    }

    pub async fn logs(&self, body: &Value) -> Result<(), Failed> {
        let req = self.post("/i/v1/logs", body).bearer_auth(&self.key);
        self.json(req).await.map(drop)
    }
}

/// `/flags?v=2` answers each flag as `{enabled, variant}`; older answers are `featureFlags: {key: value}`.
fn flag_values(answer: &Value) -> BTreeMap<String, Value> {
    if let Some(flags) = answer.get("flags").and_then(Value::as_object) {
        return flags
            .iter()
            .map(|(key, f)| {
                let value = match f.get("variant") {
                    Some(Value::String(v)) => json!(v),
                    _ => json!(f.get("enabled").and_then(Value::as_bool).unwrap_or(false)),
                };
                (key.clone(), value)
            })
            .collect();
    }
    answer
        .get("featureFlags")
        .and_then(Value::as_object)
        .map(|m| m.iter().map(|(k, v)| (k.clone(), v.clone())).collect())
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_flag_is_its_variant_or_whether_it_is_on() {
        let v2 = json!({"flags": {
            "big-trades-auto": {"key": "big-trades-auto", "enabled": true, "variant": null},
            "ticket-layout": {"key": "ticket-layout", "enabled": true, "variant": "compact"},
            "off": {"key": "off", "enabled": false}
        }});
        let flags = flag_values(&v2);
        assert_eq!(flags["big-trades-auto"], json!(true));
        assert_eq!(flags["ticket-layout"], json!("compact"));
        assert_eq!(flags["off"], json!(false));
        let v1 = json!({"featureFlags": {"a": true, "b": "x"}});
        assert_eq!(flag_values(&v1)["b"], json!("x"));
    }

    fn remote(host: String) -> Remote {
        let project = Project {
            key: Some("phc_sekrit".into()),
            host,
        };
        Remote::new(&project, "phc_sekrit".into()).unwrap()
    }

    #[tokio::test]
    async fn a_redirect_from_posthog_is_refused_not_followed() {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};

        let elsewhere = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        elsewhere.set_nonblocking(true).unwrap();
        let elsewhere_url = format!("http://{}/stolen", elsewhere.local_addr().unwrap());
        let posthog = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let host = format!("http://{}", posthog.local_addr().unwrap());
        tokio::spawn(async move {
            let (mut conn, _) = posthog.accept().await.unwrap();
            let mut request = [0u8; 4096];
            let _ = conn.read(&mut request).await.unwrap();
            let reply = format!(
                "HTTP/1.1 307 Temporary Redirect\r\nLocation: {elsewhere_url}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
            );
            conn.write_all(reply.as_bytes()).await.unwrap();
        });
        let Failed(why) = remote(host).surveys().await.unwrap_err();
        assert!(why.contains("307"), "{why}");
        assert!(
            matches!(elsewhere.accept(), Err(e) if e.kind() == std::io::ErrorKind::WouldBlock),
            "the redirect's target was asked, with the project key"
        );
    }

    #[tokio::test]
    async fn an_unreachable_posthog_is_worded_without_the_key_in_its_url() {
        let closed = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let host = format!("http://{}", closed.local_addr().unwrap());
        drop(closed);
        let r = remote(host);
        for Failed(why) in [
            r.surveys().await.unwrap_err(),
            r.config().await.unwrap_err(),
        ] {
            assert!(!why.contains("phc_sekrit"), "{why}");
        }
    }
}
