use crate::lock::DataDirLock;
use std::borrow::Cow;
use std::fs::OpenOptions;
use std::io::{self, IsTerminal, Write};
use std::sync::{Arc, OnceLock};

use parking_lot::RwLock;
use tracing_subscriber::fmt::MakeWriter;
use tracing_subscriber::layer::SubscriberExt;
use tracing_subscriber::util::SubscriberInitExt;
use tracing_subscriber::{EnvFilter, Layer};

#[derive(Default)]
pub struct Redactor {
    secrets: RwLock<Vec<String>>,
    private: RwLock<Vec<String>>,
}

impl std::fmt::Debug for Redactor {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Redactor")
            .field("secrets", &self.secrets.read().len())
            .field("private", &self.private.read().len())
            .finish()
    }
}

impl Redactor {
    pub fn global() -> &'static Redactor {
        static R: OnceLock<Redactor> = OnceLock::new();
        R.get_or_init(Redactor::default)
    }

    pub fn register(&self, secret: &str) {
        if secret.len() >= MIN_REDACTED_SECRET_LEN {
            let mut secrets = self.secrets.write();
            if !secrets.iter().any(|s| s == secret) {
                secrets.push(secret.to_owned());
            }
        }
    }

    pub fn register_private(&self, word: &str) {
        let word = word.trim();
        if word.chars().count() >= MIN_PRIVATE_WORD_LEN {
            let mut private = self.private.write();
            if !private.iter().any(|w| w == word) {
                private.push(word.to_owned());
                private.sort_by_key(|w| std::cmp::Reverse(w.len()));
            }
        }
    }

    pub fn redact<'a>(&self, text: &'a str) -> Cow<'a, str> {
        let mut out = tessera_core::token::redact(text, REDACTED);
        for s in self.secrets.read().iter() {
            if out.contains(s.as_str()) {
                out = Cow::Owned(out.replace(s.as_str(), REDACTED));
            }
        }
        out
    }

    pub fn redact_shared<'a>(&self, text: &'a str) -> Cow<'a, str> {
        let mut out = self.redact(text);
        for w in self.private.read().iter() {
            if out.contains(w.as_str()) {
                out = Cow::Owned(out.replace(w.as_str(), PRIVATE));
            }
        }
        out
    }
}

const REDACTED: &str = "[redacted]";

const PRIVATE: &str = "[private]";

const MIN_REDACTED_SECRET_LEN: usize = 8;

const MIN_PRIVATE_WORD_LEN: usize = 3;

/// The default panic hook writes the message straight to stderr.
pub fn install_panic_hook() {
    std::panic::set_hook(Box::new(|info| {
        let thread = std::thread::current();
        let mut report = format!("thread '{}' {info}", thread.name().unwrap_or("<unnamed>"));
        let backtrace = std::backtrace::Backtrace::capture();
        if backtrace.status() == std::backtrace::BacktraceStatus::Captured {
            report.push_str(&format!("\n{backtrace}"));
        }
        if tracing::enabled!(target: "panic", tracing::Level::ERROR) {
            tracing::error!(target: "panic", "{report}");
        } else {
            eprintln!("{}", Redactor::global().redact(&report));
        }
    }));
}

pub struct RedactingWriter<W: Write> {
    inner: W,
    buf: Vec<u8>,
}

impl<W: Write> Write for RedactingWriter<W> {
    fn write(&mut self, data: &[u8]) -> io::Result<usize> {
        self.buf.extend_from_slice(data);
        Ok(data.len())
    }

    fn flush(&mut self) -> io::Result<()> {
        if !self.buf.is_empty() {
            let text = String::from_utf8_lossy(&self.buf);
            self.inner
                .write_all(Redactor::global().redact(&text).as_bytes())?;
            self.buf.clear();
        }
        self.inner.flush()
    }
}

impl<W: Write> Drop for RedactingWriter<W> {
    fn drop(&mut self) {
        let _ = self.flush();
    }
}

#[derive(Clone)]
pub struct Redacting<M>(pub M);

impl<'a, M> MakeWriter<'a> for Redacting<M>
where
    M: MakeWriter<'a>,
{
    type Writer = RedactingWriter<M::Writer>;

    fn make_writer(&'a self) -> Self::Writer {
        RedactingWriter {
            inner: self.0.make_writer(),
            buf: Vec::with_capacity(256),
        }
    }
}

pub fn init(data_dir: &DataDirLock) -> io::Result<()> {
    let filter = |default: &str| {
        EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new(default))
    };
    let stderr = tracing_subscriber::fmt::layer()
        .with_writer(Redacting(io::stderr))
        .with_ansi(io::stderr().is_terminal())
        .with_target(false)
        .compact()
        .with_filter(filter("info"));
    let registry = tracing_subscriber::registry().with(stderr);
    let dir = tessera_store::DataDir::new(data_dir.dir()).logs();
    crate::private::private_dir(&dir)?;
    let mut options = OpenOptions::new();
    tessera_core::private::owner_only(&mut options);
    let file = options
        .create(true)
        .append(true)
        .open(dir.join("runtime.log"))?;
    let json = tracing_subscriber::fmt::layer()
        .json()
        .with_ansi(false)
        .with_writer(Redacting(Arc::new(file)))
        .with_filter(filter("info,tessera_runtime=debug,tower_http=info"));
    let _ = registry
        .with(json)
        .with(crate::telemetry::logs::ShipLayer)
        .with(crate::modules::feedback::RecentErrors)
        .try_init();
    Ok(())
}

#[cfg(test)]
pub(crate) static PANIC_HOOK: parking_lot::Mutex<()> = parking_lot::Mutex::new(());

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn redacts_registered_secrets() {
        let r = Redactor::default();
        r.register("short");
        r.register("0123456789abcdef");
        assert_eq!(r.redact("token=0123456789abcdef ok"), "token=[redacted] ok");
        assert!(matches!(
            r.redact("short stays"),
            Cow::Borrowed("short stays")
        ));
    }

    #[test]
    fn shared_text_also_loses_account_ids_and_logins_but_the_log_keeps_them() {
        let r = Redactor::default();
        r.register("rithmic-pw-Zq81-hunter2");
        r.register_private("APEX-123456");
        r.register_private("APEX-123456-01");
        r.register_private("tr");
        let line = "trader APEX-123456-01 on APEX-123456 with rithmic-pw-Zq81-hunter2 tr";
        assert_eq!(
            r.redact(line),
            "trader APEX-123456-01 on APEX-123456 with [redacted] tr"
        );
        assert_eq!(
            r.redact_shared(line),
            "trader [private] on [private] with [redacted] tr"
        );
    }

    #[test]
    fn redacts_every_tessera_credential_by_shape() {
        use tessera_core::token::{AGENT, SESSION, TICKET, mint};
        let r = Redactor::default();
        for kind in [SESSION, AGENT, TICKET] {
            let t = mint(kind).unwrap();
            let line = format!(
                r#"{{"msg":"Bearer {}","url":"/ws?token={}"}}"#,
                t.expose(),
                t.expose()
            );
            let out = r.redact(&line);
            assert!(!out.contains(&t.expose()[4..]), "{out}");
            assert_eq!(
                out,
                r#"{"msg":"Bearer [redacted]","url":"/ws?token=[redacted]"}"#
            );
        }
    }

    #[test]
    fn a_panic_is_written_redacted() {
        use tracing_subscriber::fmt::MakeWriter;

        #[derive(Clone, Default)]
        struct Buffer(Arc<parking_lot::Mutex<Vec<u8>>>);
        impl Write for Buffer {
            fn write(&mut self, data: &[u8]) -> io::Result<usize> {
                self.0.lock().extend_from_slice(data);
                Ok(data.len())
            }
            fn flush(&mut self) -> io::Result<()> {
                Ok(())
            }
        }
        impl<'a> MakeWriter<'a> for Buffer {
            type Writer = Buffer;
            fn make_writer(&'a self) -> Buffer {
                self.clone()
            }
        }

        let token = tessera_core::token::mint(tessera_core::token::SESSION).unwrap();
        let out = Buffer::default();
        let _hook = PANIC_HOOK.lock();
        let subscriber = tracing_subscriber::fmt()
            .with_writer(Redacting(out.clone()))
            .with_ansi(false)
            .finish();
        install_panic_hook();
        let secret = token.expose().to_owned();
        let caught = tracing::subscriber::with_default(subscriber, || {
            std::panic::catch_unwind(|| panic!("handshake with {secret} failed"))
        });
        let _ = std::panic::take_hook();
        assert!(caught.is_err());
        let written = String::from_utf8(out.0.lock().clone()).unwrap();
        assert!(
            written.contains("panicked at") && written.contains("handshake with [redacted] failed"),
            "{written}"
        );
        assert!(!written.contains(&token.expose()[4..]), "{written}");
    }

    #[test]
    fn writer_redacts_on_flush() {
        Redactor::global().register("supersecret-token-value");
        let mut out = Vec::new();
        {
            let mut w = RedactingWriter {
                inner: &mut out,
                buf: Vec::new(),
            };
            w.write_all(b"ready token=supersecret-token-value\n")
                .unwrap();
        }
        assert_eq!(String::from_utf8(out).unwrap(), "ready token=[redacted]\n");
    }
}
