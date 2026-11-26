use std::collections::HashMap;

use tessera_protocol::agent::{AgentEvent, AgentEventEnvelope, ContentBlock};
use tessera_protocol::tools::ToolOutcome;

use super::contract::{SharedBlock, SharedConversation, SharedTurn, SharedWork};
use super::words::ShareWords;
use super::{MAX_TITLE, clip};

pub const PRIVATE_NAMESPACES: &[&str] = &[
    "portfolio",
    "orders",
    "risk",
    "copy",
    "trade",
    "journal",
    "connections",
    "account",
    "alerts",
    "broker",
    "feedback",
    "share",
];

pub const UNTITLED: &str = "Analyst conversation";

pub const MAX_BODY: usize = 1_000_000;
const MAX_TURNS: usize = 400;
const MAX_USER_TEXT: usize = 20_000;
const MAX_ANSWER: usize = 60_000;
const MAX_WORK: usize = 300;
const MAX_LABEL: usize = 200;
const MAX_META: usize = 80;
const MAX_NS: usize = 40;
const MAX_BLOCKS: usize = 40;
const MAX_BLOCK_TITLE: usize = 200;
const MAX_BLOCK_TEXT: usize = 20_000;
const MAX_ROWS: usize = 100;
const MAX_ROW: usize = 200;

pub fn namespace(tool: &str) -> &str {
    tool.split('.').next().unwrap_or(tool)
}

pub fn is_private(tool: &str) -> bool {
    PRIVATE_NAMESPACES.contains(&namespace(tool))
}

pub fn spoken_title(tool: &str) -> String {
    let last = tool.rsplit('.').next().unwrap_or(tool).replace('_', " ");
    let mut c = last.trim().chars();
    match c.next() {
        Some(first) => first.to_uppercase().chain(c).collect(),
        None => tool.to_owned(),
    }
}

fn duration_words(ms: f64) -> Option<String> {
    if !ms.is_finite() || ms < 0.0 {
        return None;
    }
    if ms < 1_000.0 {
        return Some(format!("{} ms", ms.round() as u64));
    }
    if ms < 60_000.0 {
        return Some(format!("{:.1} s", ms / 1_000.0));
    }
    let s = (ms / 1_000.0).round() as u64;
    Some(format!("{} min {:02} s", s / 60, s % 60))
}

struct Folding<'a> {
    words: &'a ShareWords,
    titles: &'a dyn Fn(&str) -> String,
    calls: HashMap<&'a str, &'a str>,
}

#[derive(Default)]
struct Analyst {
    work: Vec<SharedWork>,
    steps: HashMap<String, usize>,
    messages: Vec<(String, String)>,
    blocks: Vec<SharedBlock>,
    worked_ms: Option<u64>,
}

impl Analyst {
    fn is_empty(&self) -> bool {
        self.work.is_empty()
            && self.blocks.is_empty()
            && self.messages.iter().all(|(_, t)| t.trim().is_empty())
    }

    fn message(&mut self, id: &str) -> &mut String {
        let at = match self.messages.iter().position(|(m, _)| m == id) {
            Some(at) => at,
            None => {
                self.messages.push((id.to_owned(), String::new()));
                self.messages.len() - 1
            }
        };
        &mut self.messages[at].1
    }
}

fn cleaned(words: &ShareWords, text: &str, max: usize) -> String {
    clip(&words.clean(&clip(text, max.saturating_mul(2))), max)
}

impl Folding<'_> {
    fn text(&self, text: &str, max: usize) -> String {
        cleaned(self.words, text, max)
    }

    fn label(&self, tool: &str, title: Option<&str>) -> String {
        let own = title.map(str::trim).filter(|t| !t.is_empty());
        match own {
            Some(t) if !is_private(tool) => self.text(t, MAX_LABEL),
            _ => self.text(&(self.titles)(tool), MAX_LABEL),
        }
    }

    fn block(&self, b: &ContentBlock) -> Option<SharedBlock> {
        let source = b.source_call_id.as_ref().map(|c| c.as_str());
        if source
            .and_then(|c| self.calls.get(c))
            .is_some_and(|tool| is_private(tool))
        {
            return None;
        }
        Some(SharedBlock {
            kind: b.kind,
            title: b
                .title
                .as_deref()
                .map(|t| self.text(t, MAX_BLOCK_TITLE))
                .filter(|t| !t.is_empty()),
            text: self.text(&b.text, MAX_BLOCK_TEXT),
            rows: b
                .rows
                .iter()
                .take(MAX_ROWS)
                .map(|(l, v)| (self.text(l, MAX_ROW), self.text(v, MAX_ROW)))
                .collect(),
        })
    }

    fn step(&self, a: &mut Analyst, call: &str, tool: &str, title: Option<&str>) -> usize {
        if let Some(at) = a.steps.get(call) {
            return *at;
        }
        a.work.push(SharedWork {
            ns: clip(namespace(tool), MAX_NS),
            label: self.label(tool, title),
            meta: None,
            failed: false,
        });
        a.steps.insert(call.to_owned(), a.work.len() - 1);
        a.work.len() - 1
    }

    fn turn(&self, a: Analyst) -> Option<SharedTurn> {
        if a.is_empty() {
            return None;
        }
        let answer = a
            .messages
            .iter()
            .map(|(_, t)| t.trim())
            .filter(|t| !t.is_empty())
            .collect::<Vec<_>>()
            .join("\n\n");
        Some(SharedTurn::Analyst {
            work: a.work.into_iter().take(MAX_WORK).collect(),
            worked_ms: a.worked_ms,
            answer: self.text(&answer, MAX_ANSWER),
            blocks: a.blocks.into_iter().take(MAX_BLOCKS).collect(),
        })
    }
}

pub fn title_of(session_title: &str, words: &ShareWords) -> String {
    let t = cleaned(words, session_title, MAX_TITLE);
    if t.is_empty() { UNTITLED.to_owned() } else { t }
}

pub fn fold(
    events: &[AgentEventEnvelope],
    title: String,
    words: &ShareWords,
    titles: &dyn Fn(&str) -> String,
) -> SharedConversation {
    let mut calls = HashMap::new();
    for e in events {
        if let AgentEvent::ToolCallStarted { call_id, tool, .. }
        | AgentEvent::ToolCallFinished { call_id, tool, .. } = &e.event
        {
            calls.insert(call_id.as_str(), tool.as_str());
        }
    }
    let f = Folding {
        words,
        titles,
        calls,
    };
    let mut turns = Vec::new();
    let mut cur = Analyst::default();
    for e in events {
        match &e.event {
            AgentEvent::UserMessage { text, attachments } => {
                turns.extend(f.turn(std::mem::take(&mut cur)));
                turns.push(SharedTurn::User {
                    text: f.text(text, MAX_USER_TEXT),
                    files: u32::try_from(attachments.len()).unwrap_or(u32::MAX),
                });
            }
            AgentEvent::AssistantDelta { message_id, text } => {
                cur.message(message_id).push_str(text);
            }
            AgentEvent::AssistantMessage {
                message_id,
                text,
                blocks,
            } => {
                text.clone_into(cur.message(message_id));
                cur.blocks.extend(blocks.iter().filter_map(|b| f.block(b)));
            }
            AgentEvent::ToolCallStarted {
                call_id,
                tool,
                title,
                ..
            } => {
                f.step(&mut cur, call_id.as_str(), tool, title.as_deref());
            }
            AgentEvent::ToolCallFinished {
                call_id,
                tool,
                outcome,
                duration_ms,
                ..
            } => {
                let at = f.step(&mut cur, call_id.as_str(), tool, None);
                let w = &mut cur.work[at];
                w.meta = duration_words(*duration_ms).map(|m| clip(&m, MAX_META));
                w.failed = matches!(outcome, ToolOutcome::Error | ToolOutcome::Denied);
            }
            AgentEvent::TurnFinished { duration_ms, .. } => {
                if duration_ms.is_finite() && *duration_ms >= 0.0 {
                    cur.worked_ms = Some(duration_ms.round() as u64);
                }
                turns.extend(f.turn(std::mem::take(&mut cur)));
            }
            _ => {}
        }
    }
    turns.extend(f.turn(cur));
    let skip = turns.len().saturating_sub(MAX_TURNS);
    let mut out = SharedConversation {
        v: 1,
        title,
        amounts: words.amounts(),
        turns: turns.into_iter().skip(skip).collect(),
    };
    fit(&mut out, MAX_BODY);
    out
}

fn json_len<T: serde::Serialize>(v: &T) -> usize {
    serde_json::to_vec(v).map_or(usize::MAX, |v| v.len())
}

fn size(c: &SharedConversation) -> usize {
    json_len(c).saturating_add(c.title.len() + 64)
}

pub fn fit(c: &mut SharedConversation, max: usize) {
    let turns: Vec<usize> = c
        .turns
        .iter()
        .map(|t| json_len(t).saturating_add(1))
        .collect();
    let bare = SharedConversation {
        v: c.v,
        title: c.title.clone(),
        amounts: c.amounts,
        turns: Vec::new(),
    };
    let mut total = turns.iter().fold(size(&bare), |a, b| a.saturating_add(*b));
    let mut dropped = 0;
    while total > max && dropped + 1 < turns.len() {
        total = total.saturating_sub(turns[dropped]);
        dropped += 1;
    }
    c.turns.drain(..dropped);
    while size(c) > max {
        match c.turns.first_mut() {
            Some(SharedTurn::Analyst { blocks, .. }) if !blocks.is_empty() => {
                blocks.pop();
            }
            Some(SharedTurn::Analyst { work, .. }) if !work.is_empty() => {
                work.pop();
            }
            _ => break,
        }
    }
}
