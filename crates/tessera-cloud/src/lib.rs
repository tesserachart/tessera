mod client;
pub mod pkce;

pub use client::{
    Access, Checkin, CloudAccount, CloudClient, CloudError, CloudUser, FeedbackContextItem,
    FeedbackReport, FeedbackScreenshot, FiledIssue, NewShare, SessionSink, SetupBody, ShareBody,
    ShareImage, SharedLink, SharedSetup,
};

pub const CLOUD_URL_ENV: &str = "TESSERA_CLOUD_URL";

pub fn configured_url() -> Option<String> {
    url_from(
        std::env::var(CLOUD_URL_ENV).ok().as_deref(),
        option_env!("TESSERA_CLOUD_URL"),
    )
}

pub fn url_from(now: Option<&str>, built: Option<&str>) -> Option<String> {
    let v = now.or(built)?.trim().trim_end_matches('/');
    if v.is_empty() {
        return None;
    }
    let local = ["http://127.0.0.1:", "http://localhost:", "http://[::1]:"]
        .iter()
        .any(|p| v.starts_with(p));
    if v.starts_with("https://") || local {
        Some(v.to_owned())
    } else {
        tracing::warn!(
            "{CLOUD_URL_ENV} is not an https:// address (or http:// to this machine): accounts are off"
        );
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_runtime_variable_wins_and_empty_means_off() {
        let built = Some("https://account.example.test");
        assert_eq!(
            url_from(None, built).as_deref(),
            Some("https://account.example.test")
        );
        assert_eq!(
            url_from(Some("https://staging.example.test/"), built).as_deref(),
            Some("https://staging.example.test")
        );
        assert_eq!(url_from(Some(""), built), None, "set but empty: off");
        assert_eq!(url_from(Some("  "), None), None);
        assert_eq!(url_from(None, None), None, "no address: accounts off");
        assert_eq!(
            url_from(Some("http://127.0.0.1:8787"), None).as_deref(),
            Some("http://127.0.0.1:8787")
        );
        assert_eq!(url_from(Some("http://account.example.test"), None), None);
        assert_eq!(url_from(Some("account.example.test"), None), None);
    }
}
