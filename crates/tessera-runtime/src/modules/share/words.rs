use std::sync::OnceLock;

use regex_automata::meta::Regex;

use crate::modules::feedback::Scrubber;

pub const SIZE: &str = "[size]";
pub const AMOUNT: &str = "[amount]";

const PLAIN_MEASURES: &[&str] = &[
    "%", "percent", "tick", "ticks", "point", "points", "pt", "pts", "handle", "handles", "bar",
    "bars", "candle", "candles", "minute", "minutes", "min", "mins", "second", "seconds", "sec",
    "hour", "hours", "day", "days", "week", "weeks", "month", "months", "year", "years", "time",
    "times", "r", "x", "atr", "sd", "std", "level", "levels",
];

const COUNTS: &[&str] = &[
    "trade",
    "trades",
    "of",
    "contract",
    "contracts",
    "lot",
    "lots",
    "share",
    "shares",
    "[size]",
];

const STUDIES: &[&str] = &[
    "ema", "sma", "wma", "vwap", "rsi", "macd", "period", "periods", "length", "m", "h", "s",
];

const LAYOUT_SIZES: &[&str] = &[
    "tick", "row", "font", "step", "bar", "box", "brick", "bucket", "text", "label", "point",
    "page", "sample", "window", "file", "batch", "pane", "cell", "dot", "line",
];

type Words = &'static [&'static str];

type Lists = &'static [Words];

const LEVEL_WORDS: Words = &["stop", "take", "target"];

struct Rule {
    pattern: &'static str,
    token: &'static str,
    not_before: Lists,
    not_after: Words,
}

const SIZE_RULES: &[Rule] = &[
    Rule {
        pattern: r"(?i)\b\d{1,4}(?:\.\d+)?\s*(?:contracts?|lots?|micros?|minis?|shares|units)\b",
        token: SIZE,
        not_before: &[],
        not_after: &[],
    },
    Rule {
        pattern: r"(?i)\b\d{1,4}-lots?\b",
        token: SIZE,
        not_before: &[],
        not_after: &[],
    },
    Rule {
        pattern: r"(?i)\b(?:long|short|buy|sell|bought|sold|buying|selling|add|added|adding|adds|trim|trimmed|trimming|trims|cover|covered|covering|hold|holds|holding|held|reduce|reduced|reducing|exit|exited|exiting|scaled?\s+(?:in|out)|scaling\s+(?:in|out))\s+(?:x\s*)?([+\-−]?\d{1,4})\b",
        token: SIZE,
        not_before: &[PLAIN_MEASURES, STUDIES],
        not_after: &[],
    },
    Rule {
        pattern: r"(?i)\b(?:qty|quantity|position\s+size|position|pos|size)\s*(?:[:=]|of|is|was|now)?\s*([+\-−]?\d{1,4})\b",
        token: SIZE,
        not_before: &[PLAIN_MEASURES, STUDIES],
        not_after: LAYOUT_SIZES,
    },
];

const NUMBER: &str = r"[+\-−]?\s*\d[\d,]*(?:\.\d+)?(?:\s*[kKmM]\b)?";

fn money_rules() -> &'static [(String, Lists, Words)] {
    static R: OnceLock<Vec<(String, Lists, Words)>> = OnceLock::new();
    R.get_or_init(|| {
        let n = NUMBER;
        vec![
            (format!(r"((?:[+\-−]\s*)?[$€£¥]\s*{n})"), &[], &[]),
            (
                format!(r"(?i)\b(?:usd|eur|gbp|chf|jpy|aud|cad)\s*({n})"),
                &[],
                &[],
            ),
            (
                format!(
                    r"(?i)({n}\s*(?:usd|eur|gbp|chf|jpy|aud|cad|dollars?|bucks|euros?|quid))\b"
                ),
                &[],
                &[],
            ),
            (
                format!(
                    r"(?i)(?:\bP\s*&\s*L|\bP/L|\bPnL\b|\bprofits?\b|\bloss(?:es)?\b|\bgains?\b|\bbalance\b|\bequity\b|\bdrawdown\b|\brealized\b|\bunrealized\b|\brealised\b|\bunrealised\b|\bnet\s+liq(?:uidation)?\b|\bcash\b)\s*(?:\(|:|=|of|is|was|now|so\s+far|today|for\s+the\s+day|on\s+the\s+day|stands\s+at|sits\s+at)?\s*\(?\s*({n})"
                ),
                &[PLAIN_MEASURES, COUNTS],
                LEVEL_WORDS,
            ),
            (
                format!(
                    r"(?i)\b(?:up|down)\s+({n})\s+(?:today|on\s+the\s+day|this\s+week|this\s+month|this\s+session|so\s+far|overall|on\s+the\s+week)\b"
                ),
                &[],
                &[],
            ),
            (
                format!(
                    r"(?i)\b(?:made|lost|won|gained|earned|banked|booked|netted|cleared|grossed|paid|lose|make|losing|making)\s+(?:about\s+|around\s+|roughly\s+|another\s+)?({n})"
                ),
                &[PLAIN_MEASURES, COUNTS],
                &[],
            ),
            (
                r"(?i)([+\-−]\d[\d,]*(?:\.\d+)?)\s+(?:today|on\s+the\s+day|this\s+week|this\s+month|this\s+session|so\s+far)\b"
                    .to_owned(),
                &[],
                &[],
            ),
        ]
    })
}

struct Compiled {
    re: Regex,
    token: &'static str,
    not_before: Lists,
    not_after: Words,
}

fn sizes() -> &'static [Compiled] {
    static C: OnceLock<Vec<Compiled>> = OnceLock::new();
    C.get_or_init(|| {
        SIZE_RULES
            .iter()
            .map(|r| Compiled {
                re: Regex::new(r.pattern).expect("every size rule compiles"),
                token: r.token,
                not_before: r.not_before,
                not_after: r.not_after,
            })
            .collect()
    })
}

fn amounts() -> &'static [Compiled] {
    static C: OnceLock<Vec<Compiled>> = OnceLock::new();
    C.get_or_init(|| {
        money_rules()
            .iter()
            .map(|(pattern, not_before, not_after)| Compiled {
                re: Regex::new(pattern).expect("every money rule compiles"),
                token: AMOUNT,
                not_before,
                not_after,
            })
            .collect()
    })
}

fn continues_a_number(after: &str) -> bool {
    let mut c = after.chars();
    match (c.next(), c.next()) {
        (Some('%'), _) => true,
        (Some('.' | ',' | ':' | '/'), Some(d)) => d.is_ascii_digit(),
        _ => false,
    }
}

fn next_word(after: &str) -> String {
    let t = after.trim_start();
    if t.starts_with('%') {
        return "%".to_owned();
    }
    if t.starts_with(SIZE) {
        return SIZE.to_owned();
    }
    t.chars()
        .take_while(|c| c.is_alphanumeric())
        .collect::<String>()
        .to_lowercase()
}

fn last_word(before: &str) -> String {
    let t = before.trim_end();
    let word: String = t
        .chars()
        .rev()
        .take_while(|c| c.is_alphanumeric())
        .collect();
    word.chars().rev().collect::<String>().to_lowercase()
}

impl Compiled {
    fn holds(&self, text: &str, start: usize, end: usize) -> bool {
        let after = &text[end..];
        if continues_a_number(after) {
            return false;
        }
        let next = next_word(after);
        if self
            .not_before
            .iter()
            .any(|list| list.contains(&next.as_str()))
        {
            return false;
        }
        let prev = last_word(&text[..start]);
        !self.not_after.contains(&prev.as_str())
    }

    fn apply(&self, text: &str) -> String {
        let mut out = String::with_capacity(text.len());
        let mut at = 0;
        for caps in self.re.captures_iter(text) {
            let Some(m) = caps.get_match() else {
                continue;
            };
            let span = caps.get_group(1).unwrap_or_else(|| m.span());
            if span.start < at || !self.holds(text, m.start(), m.end()) {
                continue;
            }
            out.push_str(&text[at..span.start]);
            out.push_str(self.token);
            at = span.end;
        }
        out.push_str(&text[at..]);
        out
    }
}

pub fn hide_sizes(text: &str) -> String {
    sizes()
        .iter()
        .fold(text.to_owned(), |out, rule| rule.apply(&out))
}

pub fn hide_amounts(text: &str) -> String {
    amounts()
        .iter()
        .fold(text.to_owned(), |out, rule| rule.apply(&out))
}

#[derive(Clone, Debug)]
pub struct ShareWords {
    scrubber: Scrubber,
    amounts: bool,
}

impl ShareWords {
    pub fn new(private: impl IntoIterator<Item = String>, amounts: bool) -> Self {
        Self {
            scrubber: Scrubber::new(private),
            amounts,
        }
    }

    pub fn amounts(&self) -> bool {
        self.amounts
    }

    pub fn clean(&self, text: &str) -> String {
        let out = hide_sizes(&self.scrubber.scrub(text));
        if self.amounts {
            out
        } else {
            hide_amounts(&out)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const PRIVATE: &[&str] = &[
        "APEX-1234567-01",
        "Funded Bob",
        "paper-main",
        "Paper Sim 2",
        "••••4821",
    ];

    const LEAKS: &[(&str, &[&str])] = &[
        ("order refused on APEX-1234567-01", &["1234567"]),
        ("Funded Bob is locked for the day", &["Bob"]),
        ("filled on paper-main at the open", &["paper-main"]),
        ("Paper Sim 2 took the fill", &["Sim 2"]),
        ("the account ••••4821 is flat", &["4821"]),
        ("account PA1234567 is locked", &["1234567"]),
        ("signed in as trader@example.test", &["trader@"]),
        ("runtime on box.tail1234.ts.net", &["tail1234"]),
        (
            "token eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NSJ9.c2lnbmF0dXJl",
            &["eyJ"],
        ),
        ("you are up $1,240 on the day", &["1,240"]),
        ("the stop cost -$85.50", &["85.50"]),
        ("P&L +1,240 so far", &["1,240"]),
        ("P/L: -320.75", &["320.75"]),
        ("closed +1,240 USD", &["1,240"]),
        ("a €300 loss", &["300"]),
        ("up 450 today", &["450"]),
        ("unrealized +2,150", &["2,150"]),
        ("balance 51,240", &["51,240"]),
        ("made 600 on the ES trade", &["600"]),
        ("2 contracts", &["2"]),
        ("3 lots on", &["3"]),
        ("a 3-lot", &["3"]),
        ("long 2 NQ from the open", &["2"]),
        ("sold 4 ES into the high", &["4"]),
        ("qty 3", &["3"]),
        ("size: 4", &["4"]),
        ("position 2 NQ", &["2"]),
        ("Buy 2 NQ limit 21450.25, stop 21440", &["Buy 2", "2 NQ"]),
    ];

    const KEEPS: &[&str] = &[
        "NQZ6 tagged 21,450.25 and held",
        "the high at 21,450.25, the low at 21,380.00",
        "VWAP 21,432.50 held",
        "down 1.2% today",
        "+0.8% on the day",
        "14:30 ET",
        "09:30:00",
        "RSI 14 crossed 70",
        "ATR 14 is 32.5 points",
        "the 20 EMA",
        "NQZ6",
        "a 3 tick stop",
        "12 points of range",
        "hold 20 minutes",
        "tick size 0.25",
        "row size 4 ticks",
        "a 1.5R target",
        "lost 3 ticks",
        "a loss of 12 points",
        "profit target 2 ATR",
        "5m bars",
        "3 of 5 trades",
        "stop loss 21,440",
        "take profit 21,500.75",
    ];

    fn words(amounts: bool) -> ShareWords {
        ShareWords::new(PRIVATE.iter().map(|w| (*w).to_owned()), amounts)
    }

    #[test]
    fn nothing_private_survives_a_share() {
        let w = words(false);
        for (text, secrets) in LEAKS {
            let out = w.clean(text);
            for secret in *secrets {
                assert!(!out.contains(secret), "{secret} survived in {out:?}");
            }
        }
    }

    #[test]
    fn readings_of_the_market_stay() {
        let w = words(false);
        for text in KEEPS {
            assert_eq!(w.clean(text), *text);
        }
    }

    #[test]
    fn amounts_stay_when_asked_and_sizes_never_do() {
        let w = words(true);
        assert_eq!(w.clean("P&L +1,240 so far"), "P&L +1,240 so far");
        assert_eq!(w.clean("you are up $1,240"), "you are up $1,240");
        assert_eq!(w.clean("long 2 NQ, up $450"), "long [size] NQ, up $450");
        assert_eq!(
            w.clean("2 contracts on APEX-1234567-01"),
            "[size] on [account]"
        );
        let hidden = words(false);
        assert_eq!(
            hidden.clean("long 2 NQ, up $450"),
            "long [size] NQ, up [amount]"
        );
        assert_eq!(hidden.clean("P&L +1,240 so far"), "P&L [amount] so far");
        assert_eq!(hidden.clean("a 3-lot"), "a [size]");
        assert_eq!(hidden.clean("qty 3"), "qty [size]");
    }
}
