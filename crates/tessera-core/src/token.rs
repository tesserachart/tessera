use std::borrow::Cow;
use std::ops::Range;

use serde::{Deserialize, Serialize};

pub const SESSION: &str = "tss_";
pub const AGENT: &str = "tsk_";
pub const TICKET: &str = "tst_";

const KINDS: [&str; 3] = [SESSION, AGENT, TICKET];
const LEN: usize = 4 + 64;

#[derive(Clone, Serialize, Deserialize)]
#[serde(transparent)]
pub struct Secret(String);

impl Secret {
    pub fn new(s: impl Into<String>) -> Self {
        Self(s.into())
    }

    pub fn expose(&self) -> &str {
        &self.0
    }
}

impl std::fmt::Debug for Secret {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("[redacted]")
    }
}

impl PartialEq for Secret {
    fn eq(&self, other: &Self) -> bool {
        constant_time_eq(self.0.as_bytes(), other.0.as_bytes())
    }
}

impl Eq for Secret {}

pub fn mint(kind: &str) -> std::io::Result<Secret> {
    let mut bytes = [0u8; 32];
    getrandom::fill(&mut bytes).map_err(|e| std::io::Error::other(e.to_string()))?;
    Ok(Secret(format!("{kind}{}", hex::encode(bytes))))
}

pub fn constant_time_eq(a: &[u8], b: &[u8]) -> bool {
    a.len() == b.len() && a.iter().zip(b).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

pub fn find(text: &str) -> impl Iterator<Item = Range<usize>> + '_ {
    text.match_indices('_').filter_map(|(underscore, _)| {
        let start = underscore.checked_sub(3)?;
        let candidate = text.get(start..start + LEN)?;
        let kind = KINDS.iter().any(|k| candidate.starts_with(k));
        let digits = candidate[4..]
            .bytes()
            .all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'));
        (kind && digits).then_some(start..start + LEN)
    })
}

pub fn redact<'a>(text: &'a str, with: &str) -> Cow<'a, str> {
    let mut spans = find(text).peekable();
    if spans.peek().is_none() {
        return Cow::Borrowed(text);
    }
    let mut out = String::with_capacity(text.len());
    let mut at = 0;
    for span in spans {
        out.push_str(&text[at..span.start]);
        out.push_str(with);
        at = span.end;
    }
    out.push_str(&text[at..]);
    Cow::Owned(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn credentials_are_prefixed_random_hex() {
        for kind in KINDS {
            let a = mint(kind).unwrap();
            assert!(a.expose().starts_with(kind) && a.expose().len() == LEN);
            assert_ne!(a, mint(kind).unwrap());
            assert_eq!(find(a.expose()).collect::<Vec<_>>(), vec![0..LEN]);
        }
    }

    #[test]
    fn a_secret_never_prints() {
        let s = mint(SESSION).unwrap();
        assert_eq!(format!("{s:?}"), "[redacted]");
        assert_eq!(format!("{:?}", Some(&s)), "Some([redacted])");
        assert_eq!(
            serde_json::to_string(&s).unwrap(),
            format!("\"{}\"", s.expose())
        );
    }

    #[test]
    fn every_kind_is_redacted_by_shape_and_nothing_else() {
        let (tss, tsk, tsr) = (
            mint(SESSION).unwrap(),
            mint(AGENT).unwrap(),
            mint(TICKET).unwrap(),
        );
        let text = format!(
            "ws?token={} Bearer {}\n{{\"ticket\":\"{}\"}} trailing",
            tss.expose(),
            tsk.expose(),
            tsr.expose()
        );
        assert_eq!(
            redact(&text, "[redacted]"),
            "ws?token=[redacted] Bearer [redacted]\n{\"ticket\":\"[redacted]\"} trailing"
        );
        let hex = "a".repeat(64);
        for other in [
            format!("tsx_{hex}"),
            format!("tsk_{}", &hex[..63]),
            format!("tsk_{}", "A".repeat(64)),
            hex.clone(),
            "user_id tsk_ ts_".to_owned(),
        ] {
            assert!(
                matches!(redact(&other, "[redacted]"), Cow::Borrowed(_)),
                "{other}"
            );
        }
        let around = format!("é{}ü", tsk.expose());
        assert_eq!(redact(&around, "·"), "é·ü");
    }
}
