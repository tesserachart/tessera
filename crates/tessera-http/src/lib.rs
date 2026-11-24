use std::time::Duration;

pub use reqwest;

const CONNECT_TIMEOUT: Duration = Duration::from_secs(5);

pub fn install_crypto() {
    let _already_installed = rustls::crypto::ring::default_provider().install_default();
}

pub fn client(
    user_agent: &str,
    request_timeout: Option<Duration>,
) -> Result<reqwest::Client, String> {
    install_crypto();
    let mut builder = reqwest::Client::builder()
        .user_agent(user_agent)
        .redirect(reqwest::redirect::Policy::none())
        .connect_timeout(CONNECT_TIMEOUT);
    if let Some(timeout) = request_timeout {
        builder = builder.timeout(timeout);
    }
    builder.build().map_err(error_words)
}

pub fn error_words(e: reqwest::Error) -> String {
    let e = e.without_url();
    let mut s = e.to_string();
    let mut src = std::error::Error::source(&e);
    while let Some(inner) = src {
        let t = inner.to_string();
        if !s.contains(&t) {
            s.push_str(": ");
            s.push_str(&t);
        }
        src = inner.source();
    }
    s
}

#[cfg(test)]
mod tests {
    use std::path::{Path, PathBuf};

    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    use super::*;

    #[tokio::test]
    async fn a_redirect_is_answered_not_followed() {
        let elsewhere = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        elsewhere.set_nonblocking(true).unwrap();
        let elsewhere_url = format!("http://{}/stolen", elsewhere.local_addr().unwrap());
        let server = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}/", server.local_addr().unwrap());
        tokio::spawn(async move {
            let (mut conn, _) = server.accept().await.unwrap();
            let mut request = [0u8; 4096];
            let _ = conn.read(&mut request).await.unwrap();
            let reply = format!(
                "HTTP/1.1 302 Found\r\nLocation: {elsewhere_url}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
            );
            conn.write_all(reply.as_bytes()).await.unwrap();
        });
        let res = client("tessera-test", Some(Duration::from_secs(5)))
            .unwrap()
            .get(url)
            .send()
            .await
            .unwrap();
        assert_eq!(res.status().as_u16(), 302);
        assert!(
            matches!(elsewhere.accept(), Err(e) if e.kind() == std::io::ErrorKind::WouldBlock),
            "the redirect's target was asked"
        );
    }

    #[tokio::test]
    async fn an_error_is_worded_without_its_url() {
        let closed = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let url = format!("http://{}/v1/key/sekrit-123", closed.local_addr().unwrap());
        drop(closed);
        let e = client("tessera-test", Some(Duration::from_secs(5)))
            .unwrap()
            .get(&url)
            .send()
            .await
            .unwrap_err();
        let words = error_words(e);
        assert!(!words.contains("sekrit"), "{words}");
        assert!(!words.is_empty());
    }

    const BUILDERS: [&str; 5] = [
        "Client::builder(",
        "ClientBuilder",
        "reqwest::Client::new(",
        "reqwest::get(",
        "reqwest::blocking",
    ];

    fn rust_files(dir: &Path, out: &mut Vec<PathBuf>) {
        let Ok(entries) = std::fs::read_dir(dir) else {
            return;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_dir() && path.file_name().is_some_and(|n| n != "target") {
                rust_files(&path, out);
            } else if path.extension().is_some_and(|e| e == "rs") {
                out.push(path);
            }
        }
    }

    fn builds_a_client(code: &str) -> bool {
        code.contains("reqwest")
            && BUILDERS.iter().any(|needle| {
                code.match_indices(needle).any(|(at, _)| {
                    !code[..at]
                        .chars()
                        .next_back()
                        .is_some_and(|c| c.is_alphanumeric() || c == '_')
                })
            })
    }

    #[test]
    fn only_this_crate_builds_an_http_client() {
        let here = Path::new(env!("CARGO_MANIFEST_DIR"));
        let crates = here.parent().unwrap();
        let shell = crates.parent().unwrap().join("apps/desktop/src-tauri");
        let mut offenders = Vec::new();
        for root in std::fs::read_dir(crates)
            .unwrap()
            .flatten()
            .map(|e| e.path())
            .chain([shell])
            .filter(|p| p != here)
        {
            let manifest = std::fs::read_to_string(root.join("Cargo.toml")).unwrap_or_default();
            if manifest
                .lines()
                .any(|l| l.trim_start().starts_with("reqwest"))
            {
                offenders.push(root.join("Cargo.toml"));
            }
            let mut files = Vec::new();
            rust_files(&root, &mut files);
            for file in files {
                if builds_a_client(&std::fs::read_to_string(&file).unwrap_or_default()) {
                    offenders.push(file);
                }
            }
        }
        assert!(
            offenders.is_empty(),
            "build HTTP clients with tessera_http::client, not reqwest directly: {offenders:#?}"
        );
    }

    #[test]
    fn the_guard_sees_each_way_to_build_a_client() {
        assert!(builds_a_client(
            "let c = reqwest::Client::builder().build();"
        ));
        assert!(builds_a_client(
            "use tessera_http::reqwest::Client;\nClient::builder()"
        ));
        assert!(builds_a_client("reqwest::Client::new()"));
        assert!(!builds_a_client("CloudClient::new(base)"));
        assert!(!builds_a_client("reqwest::Client, // held"));
    }
}
