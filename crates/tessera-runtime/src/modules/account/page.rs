use std::fmt::Write as _;
use std::sync::LazyLock;

use sha2::{Digest, Sha256};

const MARK: &str = include_str!("../../../../../packages/ui/brand/mark.svg");
const WORDMARK: &str = include_str!("../../../../../packages/ui/brand/wordmark.svg");
const FAVICON: &str = include_str!("../../../../../apps/desktop/public/favicon.svg");
const SANS: &[u8] = include_bytes!("../../../../../packages/ui/fonts/InstrumentSans-VF.woff2");

const STYLE: &str = "\
:root{color-scheme:dark}\
html,body{margin:0;height:100%}\
body{display:grid;place-items:center;box-sizing:border-box;min-height:100%;padding:24px;\
background:#073f4f;color:#e8eef3;text-align:center;\
font:400 14px/20px 'Instrument Sans',system-ui,-apple-system,'Segoe UI',sans-serif;\
-webkit-font-smoothing:antialiased}\
main{--t:clamp(112px,21vh,224px);position:relative;display:flex;flex-direction:column;align-items:center}\
.t{height:var(--t)}\
.wm{height:calc(var(--t)*.3);margin-top:calc(var(--t)*.16)}\
.t svg,.wm svg{display:block;height:100%;width:auto}\
.say{position:absolute;top:100%;left:50%;translate:-50% 0;width:min(400px,calc(100vw - 48px))}\
h1{margin:40px 0 0;font-size:17px;line-height:24px;font-weight:500;color:#e8eef3;text-wrap:balance}\
p{margin:8px 0 0;color:#aebcc8;text-wrap:pretty}";

struct Sheet {
    style: String,
    policy: String,
}

static SHEET: LazyLock<Sheet> = LazyLock::new(|| {
    let style = format!(
        "@font-face{{font-family:'Instrument Sans';src:url(data:font/woff2;base64,{}) format('woff2');\
         font-weight:400 700;font-display:block}}{STYLE}",
        base64(SANS)
    );
    let policy = format!(
        "default-src 'none'; style-src 'sha256-{}'; font-src data:; img-src data:; base-uri 'none'; \
         form-action 'none'; frame-ancestors 'none'",
        base64(&Sha256::digest(style.as_bytes()))
    );
    Sheet { style, policy }
});

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CallbackPage {
    SignedIn,
    Expired,
    Cancelled,
    Unfinished,
    Unreachable,
    Refused,
    CloudFailed,
}

impl CallbackPage {
    pub const ALL: [Self; 7] = [
        Self::SignedIn,
        Self::Expired,
        Self::Cancelled,
        Self::Unfinished,
        Self::Unreachable,
        Self::Refused,
        Self::CloudFailed,
    ];

    pub fn status(self) -> u16 {
        match self {
            Self::SignedIn => 200,
            Self::Unreachable | Self::CloudFailed => 502,
            Self::Expired | Self::Cancelled | Self::Unfinished | Self::Refused => 400,
        }
    }

    pub fn headline(self) -> &'static str {
        match self {
            Self::SignedIn => "You’re signed in",
            Self::Expired => "This sign-in link has expired",
            Self::Cancelled => "Sign-in was cancelled",
            Self::Unfinished => "Sign-in didn’t finish",
            Self::Unreachable => "Tessera Cloud can’t be reached",
            Self::Refused => "This sign-in wasn’t accepted",
            Self::CloudFailed => "Tessera Cloud had a problem",
        }
    }

    pub fn line(self) -> &'static str {
        match self {
            Self::SignedIn => "You can close this tab and go back to Tessera.",
            Self::Expired => {
                "Each link works once, for ten minutes. If Tessera still asks you to sign in, start again there."
            }
            Self::Cancelled => "Nothing changed. To sign in, start again from Tessera.",
            Self::Unfinished => {
                "The sign-in page sent you back before it was done. Start again from Tessera."
            }
            Self::Unreachable => {
                "Your sign-in didn’t finish. Check your connection, then start again from Tessera."
            }
            Self::Refused => "Tessera Cloud didn’t accept it. Start again from Tessera.",
            Self::CloudFailed => "Your sign-in didn’t finish. Try again from Tessera in a moment.",
        }
    }

    pub fn policy() -> &'static str {
        &SHEET.policy
    }

    pub fn html(self) -> String {
        let headline = self.headline();
        format!(
            "<!doctype html><html lang=\"en\"><head><meta charset=\"utf-8\">\
             <meta name=\"viewport\" content=\"width=device-width,initial-scale=1\">\
             <meta name=\"color-scheme\" content=\"dark\"><meta name=\"theme-color\" content=\"#073f4f\">\
             <title>{headline} · Tessera</title>\
             <link rel=\"icon\" type=\"image/svg+xml\" href=\"data:image/svg+xml,{icon}\">\
             <style>{style}</style></head>\
             <body><main><div class=\"t\" role=\"img\" aria-label=\"Tessera\">{MARK}</div>\
             <div class=\"wm\" aria-hidden=\"true\">{WORDMARK}</div>\
             <div class=\"say\"><h1>{headline}</h1><p>{line}</p></div></main></body></html>",
            icon = data_url_text(FAVICON),
            style = SHEET.style,
            line = self.line(),
        )
    }
}

fn base64(bytes: &[u8]) -> String {
    const ABC: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let n = chunk
            .iter()
            .enumerate()
            .fold(0u32, |n, (i, b)| n | (u32::from(*b) << (16 - 8 * i)));
        for i in 0..4 {
            if i <= chunk.len() {
                out.push(char::from(ABC[((n >> (18 - 6 * i)) & 63) as usize]));
            } else {
                out.push('=');
            }
        }
    }
    out
}

fn data_url_text(text: &str) -> String {
    let mut out = String::with_capacity(text.len() + text.len() / 4);
    for c in text.chars() {
        match c {
            '%' | '#' | '"' | '<' | '>' | '&' | ' ' | '\n' | '\r' | '\t' => {
                let _ = write!(out, "%{:02X}", c as u32);
            }
            c => out.push(c),
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn token(name: &str) -> &'static str {
        let tokens = include_str!("../../../../../packages/ui/src/styles/tokens.css");
        let prefix = format!("--{name}: ");
        tokens
            .lines()
            .find_map(|l| l.trim().strip_prefix(prefix.as_str()))
            .and_then(|v| v.strip_suffix(';'))
            .unwrap_or_else(|| panic!("no --{name} in tokens.css"))
    }

    #[test]
    fn the_page_wears_the_brands_tokens() {
        let petrol = token("color-petrol");
        let mist = token("color-mist");
        let quiet = token("color-on-petrol-2");
        let unit: u32 = token("spacing").trim_end_matches("px").parse().unwrap();
        let gap = format!("{}px", unit * 10);
        assert!(STYLE.contains(&format!("background:{petrol};color:{mist};")));
        assert!(STYLE.contains(&format!("h1{{margin:{gap} 0 0;")));
        assert!(STYLE.contains(&format!("color:{mist};text-wrap:balance}}")));
        assert!(STYLE.contains(&format!("p{{margin:8px 0 0;color:{quiet};")));
    }

    #[test]
    fn base64_matches_rfc_4648() {
        for (input, out) in [
            ("", ""),
            ("f", "Zg=="),
            ("fo", "Zm8="),
            ("foo", "Zm9v"),
            ("foob", "Zm9vYg=="),
            ("fooba", "Zm9vYmE="),
            ("foobar", "Zm9vYmFy"),
        ] {
            assert_eq!(base64(input.as_bytes()), out, "{input}");
        }
        assert_eq!(base64(&[0xfb, 0xff]), "+/8=");
    }

    #[test]
    fn the_policy_allows_the_pages_own_style_and_nothing_else() {
        let html = CallbackPage::SignedIn.html();
        let style = html
            .split_once("<style>")
            .and_then(|(_, rest)| rest.split_once("</style>"))
            .map(|(style, _)| style)
            .unwrap();
        let hash = base64(&Sha256::digest(style.as_bytes()));
        let policy = CallbackPage::policy();
        assert!(policy.starts_with("default-src 'none';"), "{policy}");
        assert!(
            policy.contains(&format!("style-src 'sha256-{hash}'")),
            "{policy}"
        );
        assert!(!policy.contains("unsafe"), "{policy}");
        assert!(!policy.contains("script-src"), "{policy}");
        for page in CallbackPage::ALL {
            assert!(page.html().contains(style), "{page:?}");
        }
    }

    #[test]
    fn each_page_is_the_brand_with_its_words_and_no_script() {
        for page in CallbackPage::ALL {
            let html = page.html();
            assert!(html.contains("background:#073f4f"), "{page:?}");
            assert!(html.contains(MARK) && html.contains(WORDMARK), "{page:?}");
            assert!(
                html.contains(&format!("<h1>{}</h1>", page.headline())),
                "{page:?}"
            );
            assert!(
                html.contains(&format!("<p>{}</p>", page.line())),
                "{page:?}"
            );
            assert!(!html.contains("<script"), "{page:?}");
            assert!(!html.contains("terminal"), "{page:?}");
            let urls = html.replace("http://www.w3.org/2000/svg", "");
            assert!(
                !urls.contains("http:") && !urls.contains("https:"),
                "{page:?}"
            );
        }
        assert!(MARK.contains("#dcebef"), "the T is mist");
    }

    #[test]
    fn the_tab_icon_is_a_data_url_that_stays_in_its_attribute() {
        let icon = data_url_text(FAVICON);
        assert!(!icon.contains(['"', '<', '>', '#', ' ']), "{icon}");
        assert_eq!(data_url_text("a b#\"<%"), "a%20b%23%22%3C%25");
    }
}
