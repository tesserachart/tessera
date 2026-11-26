use std::sync::OnceLock;

use regex_automata::meta::Regex;

use crate::logging::Redactor;

const SECRET: &str = "[redacted]";
const ACCOUNT: &str = "[account]";

struct Rule {
    pattern: &'static str,
    with: Replacement,
}

enum Replacement {
    Fixed(&'static str),
    KeepKey,
}

const RULES: &[Rule] = &[
    Rule {
        pattern: r"(?i)\bbearer\s+[A-Za-z0-9._~+/=-]+",
        with: Replacement::Fixed("Bearer [redacted]"),
    },
    Rule {
        pattern: r"\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]*",
        with: Replacement::Fixed(SECRET),
    },
    Rule {
        pattern: r#"(?i)\b(password|passwd|pwd|secret|token|api[_-]?key|access[_-]?key|private[_-]?key|auth(?:orization)?|session|cookie|user(?:name)?|login)\s*[:=]\s*[^\s&"',;]+"#,
        with: Replacement::KeepKey,
    },
    Rule {
        pattern: r#"(?i)\b[a-z][a-z0-9+.-]*://[^\s"'<>()\[\]]+"#,
        with: Replacement::Fixed("[link]"),
    },
    Rule {
        pattern: r"[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}",
        with: Replacement::Fixed("[email]"),
    },
    Rule {
        pattern: r"\b\d{1,3}(?:\.\d{1,3}){3}(?::\d{1,5})?\b",
        with: Replacement::Fixed("[ip]"),
    },
    Rule {
        pattern: r"(?i)\b(?:[0-9a-f]{1,4}:){5,7}[0-9a-f]{1,4}\b|\b(?:[0-9a-f]{1,4}:)+:(?:[0-9a-f]{1,4}:?)*[0-9a-f]{0,4}",
        with: Replacement::Fixed("[ip]"),
    },
    Rule {
        pattern: r"(?i)\b(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+(?:com|net|org|io|dev|app|cloud|co|ai|uk|de|fr|nl|eu|us|ca|au|ch|info|biz|xyz|tech|local|lan|internal|home|corp|arpa|localhost)\b(?::\d{1,5})?",
        with: Replacement::Fixed("[host]"),
    },
    Rule {
        pattern: r"(?i)\b[a-z0-9-]+(?:\.[a-z0-9-]+)+:\d{2,5}\b",
        with: Replacement::Fixed("[host]"),
    },
    Rule {
        pattern: r"(?i)(?:/Users/|/home/|[a-z]:\\Users\\)[^/\\\s]+",
        with: Replacement::Fixed("~"),
    },
    Rule {
        pattern: r"[A-Za-z0-9_+/=-]{32,}",
        with: Replacement::Fixed(SECRET),
    },
    Rule {
        pattern: r"\b[A-Za-z]{2,}[-_]?\d{5,}(?:[-_][A-Za-z0-9]+)*\b",
        with: Replacement::Fixed(ACCOUNT),
    },
    Rule {
        pattern: r"\b\d{7,}\b",
        with: Replacement::Fixed("[number]"),
    },
];

fn compiled() -> &'static [(Regex, &'static Replacement)] {
    static C: OnceLock<Vec<(Regex, &'static Replacement)>> = OnceLock::new();
    C.get_or_init(|| {
        RULES
            .iter()
            .map(|r| {
                (
                    Regex::new(r.pattern).expect("every redaction rule compiles"),
                    &r.with,
                )
            })
            .collect()
    })
}

fn apply(text: &str, re: &Regex, with: &Replacement) -> String {
    let mut out = String::with_capacity(text.len());
    let mut at = 0;
    for m in re.find_iter(text) {
        let found = &text[m.start()..m.end()];
        if matches!(with, Replacement::Fixed(SECRET)) && !has_letter_and_digit(found) {
            continue;
        }
        out.push_str(&text[at..m.start()]);
        match with {
            Replacement::Fixed(w) => out.push_str(w),
            Replacement::KeepKey => {
                let key = found
                    .split(['=', ':'])
                    .next()
                    .unwrap_or_default()
                    .trim_end();
                out.push_str(key);
                out.push('=');
                out.push_str(SECRET);
            }
        }
        at = m.end();
    }
    out.push_str(&text[at..]);
    out
}

fn has_letter_and_digit(s: &str) -> bool {
    s.bytes().any(|b| b.is_ascii_digit()) && s.bytes().any(|b| b.is_ascii_alphabetic())
}

#[derive(Clone, Debug, Default)]
pub struct Scrubber {
    words: Vec<String>,
}

impl Scrubber {
    pub fn new(private: impl IntoIterator<Item = String>) -> Self {
        let mut words: Vec<String> = private
            .into_iter()
            .map(|w| w.trim().to_owned())
            .filter(|w| w.chars().count() >= 3)
            .collect();
        words.sort_by_key(|w| std::cmp::Reverse(w.len()));
        words.dedup();
        Self { words }
    }

    pub fn scrub_words(&self, text: &str) -> String {
        let mut out = Redactor::global().redact_shared(text).into_owned();
        for w in &self.words {
            if out.contains(w.as_str()) {
                out = out.replace(w.as_str(), ACCOUNT);
            }
        }
        out
    }

    pub fn scrub(&self, text: &str) -> String {
        let mut out = self.scrub_words(text);
        if let Some(home) = home_dir() {
            out = out.replace(&home, "~");
        }
        for (re, with) in compiled() {
            out = apply(&out, re, with);
        }
        out
    }
}

fn home_dir() -> Option<String> {
    std::env::var("HOME")
        .or_else(|_| std::env::var("USERPROFILE"))
        .ok()
        .filter(|h| h.len() > 3)
}

#[cfg(test)]
mod tests {
    use super::*;

    const LEAKS: &[(&str, &str)] = &[
        ("rithmic password", "login failed: password=hunter2-Zq81!"),
        (
            "gateway",
            "connecting to wss://rprotocol-mobile.example-broker.com:443/ws",
        ),
        ("bare host", "rituz00100.rithmic.com:443 refused"),
        ("tailnet", "runtime on box.tail1234.ts.net"),
        ("ip", "peer 10.20.30.40:443 closed"),
        ("ipv6", "peer fe80::1ff:fe23:4567:890a closed"),
        ("account id", "order refused on APEX-1234567-01"),
        ("account id inline", "account PA1234567 is locked"),
        ("email", "signed in as trader@example.test"),
        ("bearer", "authorization: Bearer abc.def.ghi"),
        (
            "jwt",
            "token eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NSJ9.c2lnbmF0dXJl",
        ),
        (
            "tessera token",
            "tss_0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
        ),
        (
            "api key",
            "api_key: sk-live-9f8e7d6c5b4a3f2e1d0c9b8a7f6e5d4c",
        ),
        (
            "long secret",
            "x 3q2+7wJLmSAoBvH9eKdfh0tUrPZ1cXgn8yIQ4M6s5Ok",
        ),
        (
            "home",
            "saved to /home/jdoe/.config/tessera/credentials.env",
        ),
        (
            "mac home",
            "saved to /Users/jdoe/Library/Application Support/Tessera",
        ),
        (
            "windows home",
            r"saved to C:\Users\jdoe\AppData\Local\Tessera",
        ),
        ("long number", "basket 98765432 rejected"),
        ("user kv", "user=jdoe system=Apex"),
    ];

    const KEPT: &[&str] = &[
        "NQZ6.CME",
        "orders.submit",
        "orders.protect",
        "tessera.ib.high",
        "Limit filled at 21450.25",
        "Buy 2 NQ limit 21450.25, stop 21440",
        "per_entry",
        "14:42:03.120",
        "Tessera 0.2.0 (a4a9ad0)",
    ];

    fn scrubber() -> Scrubber {
        Scrubber::new(["Funded-Trader-Bob".to_owned(), "x".to_owned()])
    }

    #[test]
    fn nothing_private_survives() {
        Redactor::global().register("hunter2-Zq81!");
        let s = scrubber();
        for (what, text) in LEAKS {
            let out = s.scrub(text);
            for secret in [
                "hunter2",
                "rprotocol",
                "example-broker",
                "rithmic.com",
                "tail1234",
                "10.20.30.40",
                "fe80",
                "1234567",
                "trader@",
                "abc.def",
                "eyJ",
                "tss_",
                "sk-live",
                "3q2+7wJL",
                "jdoe",
                "98765432",
            ] {
                assert!(
                    !out.contains(secret),
                    "{what}: {secret} survived in {out:?}"
                );
            }
        }
    }

    #[test]
    fn the_account_names_given_are_taken_out() {
        let out = scrubber().scrub("Funded-Trader-Bob filled; x stays");
        assert_eq!(out, "[account] filled; x stays");
    }

    #[test]
    fn trading_words_stay_readable() {
        let s = scrubber();
        for text in KEPT {
            assert_eq!(s.scrub(text), *text);
        }
    }

    #[test]
    fn code_loses_only_the_words_given_and_known_secrets() {
        Redactor::global().register("hunter4-Zq81!");
        let code = "const computeExponentialMovingAverage20 = 1; // Funded-Trader-Bob hunter4-Zq81! see https://example.test";
        assert_eq!(
            scrubber().scrub_words(code),
            "const computeExponentialMovingAverage20 = 1; // [account] [redacted] see https://example.test"
        );
    }

    #[test]
    fn a_key_keeps_its_name() {
        assert_eq!(
            scrubber().scrub("password=hunter3 and token: abc"),
            "password=[redacted] and token=[redacted]"
        );
    }
}
