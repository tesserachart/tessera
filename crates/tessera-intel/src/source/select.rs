use std::fmt;

use serde_json::Value;

#[derive(Clone, Debug, PartialEq, Eq)]
enum Step {
    Key(String),
    Index(i64),
    Filter { key: String, value: String },
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Selector {
    steps: Vec<Step>,
    text: String,
}

#[derive(Clone, Debug, PartialEq, Eq, thiserror::Error)]
#[error("selector {text:?}: {why}")]
pub struct SelectorError {
    text: String,
    why: &'static str,
}

impl fmt::Display for Selector {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.text)
    }
}

impl Selector {
    pub fn parse(text: &str) -> Result<Self, SelectorError> {
        let err = |why| SelectorError {
            text: text.to_owned(),
            why,
        };
        let mut s = text.trim();
        if let Some(rest) = s.strip_prefix('$') {
            s = rest.strip_prefix('.').unwrap_or(rest);
        }
        let mut steps = Vec::new();
        let chars: Vec<char> = s.chars().collect();
        let mut i = 0;
        let mut key = String::new();
        let flush = |key: &mut String, steps: &mut Vec<Step>| {
            if !key.is_empty() {
                steps.push(Step::Key(std::mem::take(key)));
            }
        };
        while i < chars.len() {
            match chars[i] {
                '.' => {
                    if key.is_empty()
                        && !matches!(
                            steps.last(),
                            Some(Step::Index(_) | Step::Filter { .. } | Step::Key(_))
                        )
                    {
                        return Err(err("an empty step"));
                    }
                    flush(&mut key, &mut steps);
                    if i + 1 >= chars.len() || chars[i + 1] == '.' {
                        return Err(err("an empty step"));
                    }
                    i += 1;
                }
                '[' => {
                    flush(&mut key, &mut steps);
                    let close = chars[i + 1..]
                        .iter()
                        .scan(None::<char>, |quote, &c| {
                            let at_close = quote.is_none() && c == ']';
                            match (*quote, c) {
                                (None, '"' | '\'') => *quote = Some(c),
                                (Some(q), c) if c == q => *quote = None,
                                _ => {}
                            }
                            Some(at_close)
                        })
                        .position(|at| at)
                        .ok_or_else(|| err("an unclosed ["))?;
                    let inner: String = chars[i + 1..i + 1 + close].iter().collect();
                    let inner = inner.trim();
                    let quoted = |t: &str| {
                        let q = t.chars().next()?;
                        (matches!(q, '"' | '\'') && t.len() >= 2 && t.ends_with(q))
                            .then(|| t[1..t.len() - 1].to_owned())
                    };
                    if let Some(k) = quoted(inner) {
                        steps.push(Step::Key(k));
                    } else if let Ok(n) = inner.parse::<i64>() {
                        steps.push(Step::Index(n));
                    } else if let Some((k, v)) = inner.split_once('=') {
                        let (k, v) = (k.trim(), v.trim());
                        if k.is_empty() {
                            return Err(err("a filter needs a key: [name=value]"));
                        }
                        steps.push(Step::Filter {
                            key: k.to_owned(),
                            value: quoted(v).unwrap_or_else(|| v.to_owned()),
                        });
                    } else {
                        return Err(err("[…] holds an index, a \"key\" or key=value"));
                    }
                    i += close + 2;
                }
                ']' => return Err(err("a ] without [")),
                c => {
                    key.push(c);
                    i += 1;
                }
            }
        }
        flush(&mut key, &mut steps);
        Ok(Self {
            steps,
            text: text.trim().to_owned(),
        })
    }

    pub fn select<'a>(&self, v: &'a Value) -> Option<&'a Value> {
        let mut cur = v;
        for step in &self.steps {
            cur = match step {
                Step::Key(k) => cur.as_object()?.get(k)?,
                Step::Index(n) => {
                    let a = cur.as_array()?;
                    let i = if *n < 0 {
                        a.len().checked_sub(n.unsigned_abs() as usize)?
                    } else {
                        usize::try_from(*n).ok()?
                    };
                    a.get(i)?
                }
                Step::Filter { key, value } => cur
                    .as_array()?
                    .iter()
                    .find(|item| item.get(key).is_some_and(|x| text_of(x) == *value))?,
            };
        }
        Some(cur)
    }
}

pub fn text_of(v: &Value) -> String {
    match v {
        Value::String(s) => s.clone(),
        Value::Null => String::new(),
        other => other.to_string(),
    }
}

pub fn select<'a>(selector: &str, v: &'a Value) -> Option<&'a Value> {
    Selector::parse(selector).ok()?.select(v)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn selectors_walk_keys_indexes_and_filters() {
        let v = json!({
            "zero_gamma": 30776.18,
            "data": {"levels": [{"name": "Call Wall", "price": 30800}, {"name": "Put Wall", "price": 30700}]},
            "strikes": [[30070, -0.28], [30075, -4.26]],
            "odd.key": {"x": 1}
        });
        let s = |t: &str| select(t, &v).cloned();
        assert_eq!(s("zero_gamma"), Some(json!(30776.18)));
        assert_eq!(s("$.zero_gamma"), Some(json!(30776.18)));
        assert_eq!(s("$"), Some(v.clone()));
        assert_eq!(s("data.levels[1].price"), Some(json!(30700)));
        assert_eq!(s("data.levels[name=Call Wall].price"), Some(json!(30800)));
        assert_eq!(s("data.levels[name='Put Wall'].price"), Some(json!(30700)));
        assert_eq!(s("data.levels[price=30700].name"), Some(json!("Put Wall")));
        assert_eq!(s("strikes[-1][0]"), Some(json!(30075)));
        assert_eq!(s("[\"odd.key\"].x"), Some(json!(1)));
        assert_eq!(s("missing"), None);
        assert_eq!(s("strikes[5]"), None);
        assert_eq!(s("strikes[-3]"), None);
        assert_eq!(s("zero_gamma.x"), None);
        for bad in ["a..b", "a[", "a]", "a[x]", ".a", "a.", "[=1]"] {
            assert!(Selector::parse(bad).is_err(), "{bad}");
        }
    }
}
