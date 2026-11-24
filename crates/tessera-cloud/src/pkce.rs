use sha2::{Digest, Sha256};

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
#[error("no randomness from the operating system: {0}")]
pub struct RandomError(String);

#[derive(Clone, PartialEq, Eq)]
pub struct Pkce {
    pub verifier: String,
    pub challenge: String,
}

impl std::fmt::Debug for Pkce {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Pkce")
            .field("challenge", &self.challenge)
            .finish_non_exhaustive()
    }
}

impl Pkce {
    pub fn generate() -> Result<Self, RandomError> {
        Ok(Self::from_verifier(random_token()?))
    }

    pub fn from_verifier(verifier: impl Into<String>) -> Self {
        let verifier = verifier.into();
        let challenge = challenge_of(&verifier);
        Self {
            verifier,
            challenge,
        }
    }
}

pub fn challenge_of(verifier: &str) -> String {
    base64url(&Sha256::digest(verifier.as_bytes()))
}

pub fn new_state() -> Result<String, RandomError> {
    random_token()
}

fn random_token() -> Result<String, RandomError> {
    let mut bytes = [0u8; 32];
    getrandom::fill(&mut bytes).map_err(|e| RandomError(e.to_string()))?;
    Ok(base64url(&bytes))
}

pub fn base64url(bytes: &[u8]) -> String {
    const ALPHABET: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let n = chunk
            .iter()
            .enumerate()
            .fold(0u32, |n, (i, b)| n | (u32::from(*b) << (16 - 8 * i)));
        for i in 0..=chunk.len() {
            out.push(char::from(ALPHABET[((n >> (18 - 6 * i)) & 63) as usize]));
        }
    }
    out
}

pub fn same_secret(a: &str, b: &str) -> bool {
    let (a, b) = (a.as_bytes(), b.as_bytes());
    a.len() == b.len() && a.iter().zip(b).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_challenge_is_rfc_7636s() {
        let p = Pkce::from_verifier("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk");
        assert_eq!(p.challenge, "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM");
        assert!(!format!("{p:?}").contains(&p.verifier), "never printed");
    }

    #[test]
    fn verifiers_and_states_are_shaped_like_the_sample_cloud_accepts_and_never_repeat() {
        let accepted: serde_json::Value = serde_json::from_str(include_str!(
            "../../../apps/cloud/test/desktop-sign-in.json"
        ))
        .unwrap();
        let shape = |s: &str| {
            let word = s
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_');
            (s.len(), word)
        };
        let accepted = |field: &str| shape(accepted[field].as_str().unwrap());
        let a = Pkce::generate().unwrap();
        let b = Pkce::generate().unwrap();
        assert_ne!(a.verifier, b.verifier);
        for p in [&a, &b] {
            assert_eq!(shape(&p.verifier), accepted("code_verifier"));
            assert_eq!(shape(&p.challenge), accepted("code_challenge"));
            assert_eq!(p.challenge, challenge_of(&p.verifier));
        }
        let (s, t) = (new_state().unwrap(), new_state().unwrap());
        assert_ne!(s, t);
        assert_eq!(shape(&s), accepted("state"));
    }

    #[test]
    fn base64url_matches_rfc_4648() {
        for (input, out) in [
            ("", ""),
            ("f", "Zg"),
            ("fo", "Zm8"),
            ("foo", "Zm9v"),
            ("foob", "Zm9vYg"),
            ("fooba", "Zm9vYmE"),
            ("foobar", "Zm9vYmFy"),
        ] {
            assert_eq!(base64url(input.as_bytes()), out, "{input}");
        }
        assert_eq!(base64url(&[0xfb, 0xff]), "-_8");
    }

    #[test]
    fn secrets_compare_whole() {
        assert!(same_secret("abc", "abc"));
        assert!(!same_secret("abc", "abd"));
        assert!(!same_secret("abc", "abcd"));
    }
}
