use std::cell::{Cell, RefCell};
use std::rc::Rc;
use std::time::{Duration, Instant};

use rquickjs::context::intrinsic;
use rquickjs::{
    CatchResultExt, CaughtError, Context, Ctx, Function, Module, Object, Runtime, TypedArray, Value,
};
use serde::{Deserialize, Serialize};

const MIB: usize = 1 << 20;
pub const MAX_LOG: usize = 64 * 1024;
pub(crate) const FILENAME: &str = "indicator.js";
const PRELUDE: &str = include_str!("prelude.js");
const STACK: usize = 512 * 1024;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Limits {
    pub time: Duration,
    pub memory: usize,
}

impl Limits {
    pub const INDICATOR: Limits = Limits {
        time: Duration::from_secs(2),
        memory: 64 * MIB,
    };
    pub const DESCRIBE: Limits = Limits {
        time: Duration::from_secs(1),
        memory: 32 * MIB,
    };
    pub const STUDY: Limits = Limits {
        time: Duration::from_secs(30),
        memory: 512 * MIB,
    };
    pub const IMPORT: Limits = Limits {
        time: Duration::from_secs(30),
        memory: 512 * MIB,
    };
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CodeFrame {
    pub line: u32,
    pub function: String,
    pub text: String,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CodeError {
    pub kind: String,
    pub message: String,
    pub line: Option<u32>,
    pub column: Option<u32>,
    pub text: String,
    pub frames: Vec<CodeFrame>,
    pub logs: String,
}

impl std::fmt::Display for CodeError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        if let Some(l) = self.line {
            write!(f, "line {l}: ")?;
        }
        match self.kind.as_str() {
            "CodeError" => f.write_str(&self.message),
            k if self.message.is_empty() => f.write_str(k),
            k => write!(f, "{k}: {}", self.message),
        }
    }
}

#[derive(Clone, Debug, PartialEq, thiserror::Error, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum ScriptError {
    #[error("{error}")]
    Code { error: Box<CodeError> },
    #[error("ran longer than {} (the time limit){}; look for a loop that never ends", secs(*ms), line_suffix(*line))]
    Timeout { ms: u64, line: Option<u32> },
    #[error("used more than {} MB of memory (the limit){}", limit / MIB as u64, line_suffix(*line))]
    Memory { limit: u64, line: Option<u32> },
    #[error("{message}")]
    Invalid { message: String },
    #[error("the script engine failed: {message}")]
    Internal { message: String },
}

impl ScriptError {
    pub fn internal(message: impl Into<String>) -> Self {
        ScriptError::Internal {
            message: message.into(),
        }
    }

    pub fn invalid(message: impl Into<String>) -> Self {
        ScriptError::Invalid {
            message: message.into(),
        }
    }

    pub fn line(&self) -> Option<u32> {
        match self {
            ScriptError::Code { error } => error.line,
            ScriptError::Timeout { line, .. } | ScriptError::Memory { line, .. } => *line,
            _ => None,
        }
    }

    pub(crate) fn with_logs(mut self, logs: &str) -> Self {
        if let ScriptError::Code { error } = &mut self
            && error.logs.is_empty()
        {
            error.logs = logs.to_owned();
        }
        self
    }
}

fn secs(ms: u64) -> String {
    if ms.is_multiple_of(1000) {
        format!("{} s", ms / 1000)
    } else {
        format!("{:.1} s", ms as f64 / 1000.0)
    }
}

fn line_suffix(line: Option<u32>) -> String {
    line.map(|l| format!(" (line {l})")).unwrap_or_default()
}

pub(crate) fn line_text(source: &str, line: Option<u32>) -> String {
    line.and_then(|l| source.lines().nth(l.checked_sub(1)? as usize))
        .map(|s| s.trim().to_owned())
        .unwrap_or_default()
}

#[derive(Default)]
pub(crate) struct Logs {
    text: String,
    cut: bool,
}

impl Logs {
    fn push(&mut self, s: &str) {
        if self.text.len() >= MAX_LOG {
            self.cut = true;
            return;
        }
        let room = MAX_LOG - self.text.len();
        let mut end = s.len().min(room);
        while !s.is_char_boundary(end) {
            end -= 1;
        }
        self.text.push_str(&s[..end]);
        self.text.push('\n');
        if end < s.len() {
            self.cut = true;
        }
    }

    pub(crate) fn take(&self) -> String {
        if self.cut {
            format!("{}… (output cut)", self.text)
        } else {
            self.text.clone()
        }
    }
}

fn zone_offset(zone: chrono_tz::Tz, t: f64) -> f64 {
    use chrono::{Offset, TimeZone};
    let Some(at) = chrono::DateTime::from_timestamp(t.floor() as i64, 0) else {
        return 0.0;
    };
    f64::from(
        zone.offset_from_utc_datetime(&at.naive_utc())
            .fix()
            .local_minus_utc(),
    )
}

#[derive(Clone, Default)]
pub(crate) struct Host {
    pub times: Rc<Vec<f64>>,
}

pub(crate) struct Loaded<'js> {
    pub runner: Object<'js>,
    pub module: Module<'js, rquickjs::module::Evaluated>,
}

pub(crate) fn run<T>(
    source: &str,
    limits: Limits,
    host: Host,
    f: impl for<'js> FnOnce(&Ctx<'js>, Loaded<'js>) -> rquickjs::Result<T>,
) -> Result<(T, String), ScriptError> {
    let rt = Runtime::new().map_err(|e| ScriptError::internal(e.to_string()))?;
    rt.set_memory_limit(limits.memory);
    rt.set_max_stack_size(STACK);
    let fired = Rc::new(Cell::new(false));
    let deadline = Instant::now() + limits.time;
    {
        let fired = Rc::clone(&fired);
        rt.set_interrupt_handler(Some(Box::new(move || {
            if fired.get() || Instant::now() >= deadline {
                fired.set(true);
                true
            } else {
                false
            }
        })));
    }
    let ctx = Context::custom::<(
        intrinsic::Date,
        intrinsic::Eval,
        intrinsic::RegExpCompiler,
        intrinsic::RegExp,
        intrinsic::Json,
        intrinsic::Proxy,
        intrinsic::MapSet,
        intrinsic::TypedArrays,
        intrinsic::Promise,
    )>(&rt)
    .map_err(|e| ScriptError::internal(e.to_string()))?;
    let logs = Rc::new(RefCell::new(Logs::default()));
    let out = ctx.with(|ctx| {
        let result = load(&ctx, source, &host, &logs).and_then(|loaded| f(&ctx, loaded));
        result
            .catch(&ctx)
            .map_err(|e| caught(e, source, &fired, limits))
    });
    let printed = logs.borrow().take();
    match out {
        Ok(v) => Ok((v, printed)),
        Err(e) => Err(e.with_logs(&printed)),
    }
}

fn load<'js>(
    ctx: &Ctx<'js>,
    source: &str,
    host: &Host,
    logs: &Rc<RefCell<Logs>>,
) -> rquickjs::Result<Loaded<'js>> {
    let g = ctx.globals();
    {
        let logs = Rc::clone(logs);
        g.set(
            "__log",
            Function::new(ctx.clone(), move |s: String| logs.borrow_mut().push(&s))?,
        )?;
    }
    g.set(
        "__zoneOffset",
        Function::new(ctx.clone(), |zone: String, t: f64| {
            zone.parse::<chrono_tz::Tz>()
                .ok()
                .map(|tz| zone_offset(tz, t))
        })?,
    )?;
    {
        let times = Rc::clone(&host.times);
        g.set(
            "__barOffsets",
            Function::new(
                ctx.clone(),
                move |ctx: Ctx<'js>,
                      zone: String|
                      -> rquickjs::Result<Option<TypedArray<'js, f64>>> {
                    let Ok(tz) = zone.parse::<chrono_tz::Tz>() else {
                        return Ok(None);
                    };
                    let offsets: Vec<f64> = times.iter().map(|t| zone_offset(tz, *t)).collect();
                    TypedArray::<f64>::new(ctx, offsets).map(Some)
                },
            )?,
        )?;
    }
    let mut opts = rquickjs::context::EvalOptions::default();
    opts.global = true;
    opts.strict = true;
    opts.filename = Some("tessera.js".into());
    ctx.eval_with_options::<(), _>(PRELUDE, opts)?;
    let runner: Object<'js> = g.get("__tessera")?;
    let (module, done) = Module::declare(ctx.clone(), FILENAME, source)?.eval()?;
    done.finish::<()>()?;
    Ok(Loaded { runner, module })
}

fn caught(e: CaughtError<'_>, source: &str, fired: &Cell<bool>, limits: Limits) -> ScriptError {
    let (kind, message, stack, path) = match &e {
        CaughtError::Exception(x) => (
            x.get::<_, String>("name")
                .unwrap_or_else(|_| "Error".into()),
            x.message().unwrap_or_default(),
            x.stack().unwrap_or_default(),
            x.get::<_, Option<Vec<String>>>("path").ok().flatten(),
        ),
        CaughtError::Value(v) => ("Error".into(), thrown(v), String::new(), None),
        CaughtError::Error(rquickjs::Error::Allocation) => {
            return ScriptError::Memory {
                limit: limits.memory as u64,
                line: None,
            };
        }
        CaughtError::Error(err) => return ScriptError::internal(err.to_string()),
    };
    let frames = frames(&stack, source);
    let innermost = frames.first().map(|f| f.0);
    if fired.get() || (kind == "InternalError" && message == "interrupted") {
        return ScriptError::Timeout {
            ms: limits.time.as_millis() as u64,
            line: innermost,
        };
    }
    if kind == "InternalError" && message.contains("out of memory") {
        return ScriptError::Memory {
            limit: limits.memory as u64,
            line: innermost,
        };
    }
    let mut message = message;
    let (mut line, mut column) = match frames.first() {
        Some((l, c, _)) => (Some(*l), *c),
        None => (None, None),
    };
    if let Some(path) = &path
        && line.is_none()
    {
        line = crate::indicator::declaration_line(source, path);
        column = None;
    }
    if kind == "ReferenceError" && message.starts_with("could not load module") {
        message =
            "imports are not available: ta, session, draw and console are already there".into();
        line = source
            .lines()
            .position(|l| l.trim_start().starts_with("import ") || l.contains("import("))
            .map(|i| i as u32 + 1);
        column = None;
    }
    if kind == "RangeError" && message == "Maximum call stack size exceeded" {
        message.push_str(" (a function that calls itself without end?)");
    }
    let frames: Vec<CodeFrame> = frames
        .iter()
        .rev()
        .map(|(l, _, function)| CodeFrame {
            line: *l,
            function: function.clone(),
            text: line_text(source, Some(*l)),
        })
        .collect();
    ScriptError::Code {
        error: Box::new(CodeError {
            kind,
            message,
            line,
            column,
            text: line_text(source, line),
            frames,
            logs: String::new(),
        }),
    }
}

fn thrown(v: &Value<'_>) -> String {
    if let Some(s) = v.as_string().and_then(|s| s.to_string().ok()) {
        return s;
    }
    if let Some(n) = v.as_number() {
        return n.to_string();
    }
    format!("a {} was thrown", v.type_name())
}

fn frames(stack: &str, source: &str) -> Vec<(u32, Option<u32>, String)> {
    let lines = source.lines().count() as u32;
    let mut out = Vec::new();
    for l in stack.lines() {
        let l = l.trim();
        let Some(rest) = l.strip_prefix("at ") else {
            continue;
        };
        let (function, place) = match rest.rfind(" (") {
            Some(i) if rest.ends_with(')') => (&rest[..i], &rest[i + 2..rest.len() - 1]),
            _ => ("<module>", rest),
        };
        let Some(place) = place
            .strip_prefix(FILENAME)
            .and_then(|p| p.strip_prefix(':'))
        else {
            continue;
        };
        let mut parts = place.split(':');
        let Some(line) = parts.next().and_then(|p| p.parse::<u32>().ok()) else {
            continue;
        };
        if line == 0 || line > lines.max(1) {
            continue;
        }
        let column = parts.next().and_then(|p| p.parse::<u32>().ok());
        out.push((line, column, function.to_owned()));
    }
    out
}
