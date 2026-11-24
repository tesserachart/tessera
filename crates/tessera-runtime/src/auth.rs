//! A browser page cannot set headers on a WebSocket. Browsers send a `127.0.0.1` cookie to every
//! port of `127.0.0.1`, whatever its `HttpOnly`/`SameSite` attributes, so any other local HTTP
//! server the browser visits receives it.

use std::collections::HashMap;
use std::time::{Duration, Instant};

use axum::http::HeaderMap;
use axum::http::header::ORIGIN;
use parking_lot::Mutex;
use tessera_core::token::{self, Secret, constant_time_eq};

#[derive(Clone, Debug)]
pub struct SessionToken(Secret);

impl SessionToken {
    pub fn generate() -> std::io::Result<Self> {
        token::mint(token::SESSION).map(Self)
    }

    pub fn expose(&self) -> &str {
        self.0.expose()
    }

    pub fn secret(&self) -> Secret {
        self.0.clone()
    }

    pub fn matches(&self, candidate: &str) -> bool {
        constant_time_eq(self.0.expose().as_bytes(), candidate.as_bytes())
    }
}

pub const LAUNCH_LINK_FILE: &str = "launch-link";

pub fn remove_launch_link(data_dir: &std::path::Path) {
    let _ = std::fs::remove_file(data_dir.join(LAUNCH_LINK_FILE));
}

pub const RELOAD_GRACE: Duration = Duration::from_secs(60);

pub type LaunchSink = std::sync::Arc<dyn Fn(&Secret) + Send + Sync>;

pub struct Tickets {
    reload: Mutex<HashMap<String, Option<Instant>>>,
    launch: Option<(Mutex<Secret>, LaunchSink)>,
}

impl std::fmt::Debug for Tickets {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Tickets")
            .field("reload", &self.reload.lock().len())
            .field("launch", &self.launch.is_some())
            .finish()
    }
}

impl Tickets {
    pub fn new(launch: Option<LaunchSink>) -> std::io::Result<Self> {
        let launch = match launch {
            Some(sink) => Some((Mutex::new(token::mint(token::TICKET)?), sink)),
            None => None,
        };
        Ok(Self {
            reload: Mutex::new(HashMap::new()),
            launch,
        })
    }

    pub fn announce_launch(&self) {
        if let Some((current, sink)) = &self.launch {
            sink(&current.lock());
        }
    }

    pub fn issue(&self, now: Instant) -> std::io::Result<Secret> {
        let ticket = token::mint(token::TICKET)?;
        let mut live = self.reload.lock();
        live.retain(|_, closed| closed.is_none_or(|at| now.duration_since(at) < RELOAD_GRACE));
        live.insert(ticket.expose().to_owned(), None);
        Ok(ticket)
    }

    pub fn closed(&self, ticket: &Secret, now: Instant) {
        if let Some(closed) = self.reload.lock().get_mut(ticket.expose()) {
            *closed = Some(now);
        }
    }

    pub fn redeem(&self, ticket: &str, now: Instant) -> bool {
        if ticket.is_empty() {
            return false;
        }
        let reload = self.reload.lock().remove(ticket);
        if let Some(closed) = reload {
            return closed.is_none_or(|at| now.duration_since(at) < RELOAD_GRACE);
        }
        let Some((current, sink)) = &self.launch else {
            return false;
        };
        let mut current = current.lock();
        if !constant_time_eq(current.expose().as_bytes(), ticket.as_bytes()) {
            return false;
        }
        match token::mint(token::TICKET) {
            Ok(next) => {
                *current = next;
                sink(&current);
            }
            Err(e) => {
                tracing::error!(error = %e, "could not mint the next launch ticket");
                *current = Secret::new(String::new());
            }
        }
        true
    }
}

#[derive(Clone, Debug, Default)]
pub struct OriginPolicy {
    review_origins: Vec<String>,
}

impl OriginPolicy {
    pub fn new(review_origins: Vec<String>) -> Self {
        Self {
            review_origins: review_origins
                .into_iter()
                .map(|o| o.trim_end_matches('/').to_owned())
                .collect(),
        }
    }

    pub fn allows(&self, origin: &str) -> bool {
        let o = origin.trim_end_matches('/');
        if matches!(
            o,
            "tauri://localhost" | "http://tauri.localhost" | "https://tauri.localhost"
        ) {
            return true;
        }
        if self.review_origins.iter().any(|r| r == o) {
            return true;
        }
        for host in ["http://localhost", "http://127.0.0.1", "http://[::1]"] {
            if let Some(rest) = o.strip_prefix(host) {
                if rest.is_empty() {
                    return true;
                }
                if let Some(port) = rest.strip_prefix(':') {
                    return !port.is_empty() && port.parse::<u16>().is_ok();
                }
            }
        }
        false
    }

    pub fn check(&self, headers: &HeaderMap) -> bool {
        match headers.get(ORIGIN) {
            None => true,
            Some(v) => v.to_str().is_ok_and(|o| self.allows(o)),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::http::HeaderValue;

    #[test]
    fn tokens() {
        let t = SessionToken::generate().unwrap();
        assert!(t.expose().starts_with("tss_") && t.expose().len() == 68);
        assert!(t.matches(t.expose()));
        assert!(!t.matches("x"));
        assert!(!format!("{t:?}").contains(&t.expose()[4..]));
        assert_ne!(t.expose(), SessionToken::generate().unwrap().expose());
    }

    #[test]
    fn origins() {
        let p = OriginPolicy::new(vec!["https://review.example.test/".into()]);
        for ok in [
            "tauri://localhost",
            "http://tauri.localhost",
            "http://localhost:5173",
            "http://127.0.0.1:7417",
            "http://[::1]:8080",
            "http://localhost",
            "https://review.example.test",
        ] {
            assert!(p.allows(ok), "{ok}");
        }
        for bad in [
            "https://evil.example",
            "http://localhost.evil.example",
            "http://127.0.0.1.nip.io:80",
            "http://localhost:abc",
            "null",
            "https://localhost:5173",
        ] {
            assert!(!p.allows(bad), "{bad}");
        }
        let mut h = HeaderMap::new();
        assert!(p.check(&h));
        h.insert(ORIGIN, HeaderValue::from_static("https://evil.example"));
        assert!(!p.check(&h));
    }

    #[test]
    fn a_reload_ticket_is_taken_once_within_its_grace() {
        let tickets = Tickets::new(None).unwrap();
        let t0 = Instant::now();
        let open = tickets.issue(t0).unwrap();
        assert!(open.expose().starts_with("tst_"));
        assert!(tickets.redeem(open.expose(), t0));
        assert!(!tickets.redeem(open.expose(), t0));

        let closed = tickets.issue(t0).unwrap();
        tickets.closed(&closed, t0);
        assert!(tickets.redeem(closed.expose(), t0 + RELOAD_GRACE - Duration::from_secs(1)));

        let late = tickets.issue(t0).unwrap();
        tickets.closed(&late, t0);
        assert!(!tickets.redeem(late.expose(), t0 + RELOAD_GRACE));

        let stale = tickets.issue(t0).unwrap();
        tickets.closed(&stale, t0);
        let kept = tickets.issue(t0).unwrap();
        let _ = tickets.issue(t0 + RELOAD_GRACE).unwrap();
        assert!(!tickets.reload.lock().contains_key(stale.expose()));
        assert!(tickets.redeem(kept.expose(), t0 + RELOAD_GRACE * 10));

        assert!(!tickets.redeem("tst_unknown", t0));
        assert!(!tickets.redeem("", t0));
        assert!(!format!("{tickets:?}").contains("tst_"));
    }

    #[test]
    fn a_launch_ticket_is_taken_once_and_replaced() {
        let handed = std::sync::Arc::new(Mutex::new(Vec::<String>::new()));
        let sink: LaunchSink = {
            let handed = std::sync::Arc::clone(&handed);
            std::sync::Arc::new(move |t: &Secret| handed.lock().push(t.expose().to_owned()))
        };
        let tickets = Tickets::new(Some(sink)).unwrap();
        assert!(handed.lock().is_empty(), "nothing before the ready line");
        tickets.announce_launch();
        let first = handed.lock()[0].clone();
        assert!(first.starts_with("tst_"));
        let now = Instant::now();
        assert!(tickets.redeem(&first, now + RELOAD_GRACE * 100));
        assert!(!tickets.redeem(&first, now));
        let second = handed.lock()[1].clone();
        assert_ne!(second, first);
        assert!(tickets.redeem(&second, now));
        assert_eq!(handed.lock().len(), 3);
    }
}
