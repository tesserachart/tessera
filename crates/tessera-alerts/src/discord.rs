use std::time::Duration;

use async_trait::async_trait;
use chrono_tz::Tz;
use serde_json::{Value, json};
use tessera_http::reqwest;

use crate::deps::WebhookSender;
use crate::io::{AlertFire, fmt_price};

const HOSTS: [&str; 4] = [
    "discord.com",
    "discordapp.com",
    "ptb.discord.com",
    "canary.discord.com",
];

pub fn check_webhook(url: &str) -> Result<(), String> {
    let bad =
        || Err("that is not a Discord webhook URL (https://discord.com/api/webhooks/…)".to_owned());
    let Some(rest) = url.strip_prefix("https://") else {
        return bad();
    };
    let Some((host, path)) = rest.split_once('/') else {
        return bad();
    };
    if !HOSTS.contains(&host) {
        return bad();
    }
    let parts: Vec<&str> = path.trim_end_matches('/').split('/').collect();
    match parts.as_slice() {
        ["api", "webhooks", id, token]
            if !id.is_empty()
                && id.chars().all(|c| c.is_ascii_digit())
                && !token.is_empty()
                && token
                    .chars()
                    .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_') =>
        {
            Ok(())
        }
        _ => bad(),
    }
}

fn clock(f: &AlertFire, zone: Tz) -> String {
    f.at.in_tz(zone).format("%H:%M:%S %Z").to_string()
}

pub fn fire_message(f: &AlertFire, zone: Tz) -> Value {
    let size = f
        .size
        .map(|s| format!(": {} contracts", fmt_price(s)))
        .unwrap_or_default();
    let mut content = format!(
        "**{}**{size} at {} · {}",
        f.title,
        fmt_price(f.price),
        clock(f, zone)
    );
    if let Some(m) = &f.message {
        content.push('\n');
        content.push_str(m);
    }
    json!({
        "username": "Tessera",
        "content": content,
        "allowed_mentions": { "parse": [] },
    })
}

pub fn test_message() -> Value {
    json!({
        "username": "Tessera",
        "content": "Tessera alerts will post here.",
        "allowed_mentions": { "parse": [] },
    })
}

const SEND_TIMEOUT: Duration = Duration::from_secs(10);

#[derive(Clone, Debug)]
pub struct ReqwestSender {
    client: reqwest::Client,
}

impl ReqwestSender {
    pub fn new(user_agent: &str) -> Result<Self, String> {
        let client = tessera_http::client(user_agent, Some(SEND_TIMEOUT))?;
        Ok(Self { client })
    }
}

#[async_trait]
impl WebhookSender for ReqwestSender {
    async fn post(&self, url: &str, body: &Value) -> Result<(), String> {
        let bytes = serde_json::to_vec(body).map_err(|e| e.to_string())?;
        let res = self
            .client
            .post(url)
            .header(reqwest::header::CONTENT_TYPE, "application/json")
            .body(bytes)
            .send()
            .await
            .map_err(|e| {
                format!(
                    "Discord could not be reached: {}",
                    tessera_http::error_words(e)
                )
            })?;
        let status = res.status();
        if status.is_success() {
            Ok(())
        } else if status.as_u16() == 404 || status.as_u16() == 401 {
            Err("Discord does not know this webhook any more; paste a new one".into())
        } else if status.as_u16() == 429 {
            Err("Discord is rate limiting the webhook".into())
        } else {
            Err(format!("Discord answered {}", status.as_u16()))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tessera_core::{InstrumentId, Timestamp};

    #[test]
    fn only_discord_webhooks_are_taken() {
        assert!(check_webhook("https://discord.com/api/webhooks/123456/abc-DEF_9").is_ok());
        assert!(check_webhook("https://discordapp.com/api/webhooks/1/x/").is_ok());
        for bad in [
            "http://discord.com/api/webhooks/1/x",
            "https://evil.example/api/webhooks/1/x",
            "https://discord.com.evil.example/api/webhooks/1/x",
            "https://discord.com/api/webhooks/abc/x",
            "https://discord.com/api/webhooks/1",
            "https://discord.com/api/webhooks/1/x?wait=true",
            "",
        ] {
            let e = check_webhook(bad).unwrap_err();
            assert!(bad.is_empty() || !e.contains(bad), "{bad}");
        }
    }

    #[test]
    fn a_firing_names_the_symbol_condition_price_and_time() {
        let f = AlertFire {
            id: "af_1".into(),
            alert_id: "al_1".into(),
            symbol: "NQ".into(),
            instrument: InstrumentId::new("NQZ6.CME").unwrap(),
            title: "NQ crosses above 21000".into(),
            message: Some("@everyone check the book".into()),
            price: 21000.25,
            target: Some(21000.0),
            at: Timestamp::parse("2026-10-02T18:42:30Z").unwrap(),
            bar_time: None,
            source: "Apex · Rithmic".into(),
            deliver: Default::default(),
            discord: None,
            analyst: None,
            size: None,
            side: None,
        };
        let m = fire_message(&f, chrono_tz::America::New_York);
        assert_eq!(
            m["content"],
            "**NQ crosses above 21000** at 21000.25 · 14:42:30 EDT\n@everyone check the book"
        );
        assert_eq!(m["allowed_mentions"]["parse"], json!([]));
        let in_zone = |zone| {
            fire_message(&f, zone)["content"]
                .as_str()
                .unwrap()
                .to_owned()
        };
        assert!(in_zone(chrono_tz::Europe::London).contains("· 19:42:30 BST\n"));
        assert!(in_zone(chrono_tz::Asia::Tokyo).contains("· 03:42:30 JST\n"));
        let winter = AlertFire {
            at: Timestamp::parse("2026-12-02T18:42:30Z").unwrap(),
            ..f
        };
        let m = fire_message(&winter, chrono_tz::Europe::London);
        assert!(m["content"].as_str().unwrap().contains("· 18:42:30 GMT\n"));
    }
}
